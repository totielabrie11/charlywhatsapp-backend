import { Router } from "express";
import { db } from "@workspace/db";
import {
  marketingSegmentsTable,
  clientsTable,
  clientProfilesTable,
  conversationsTable,
  tasksTable,
  opportunitiesTable,
} from "@workspace/db";
import { eq, and, desc, sql, or, gte, lte, ilike, exists } from "drizzle-orm";
import type { FilterRule } from "@workspace/db";

const router = Router();

// ─── CRUD ─────────────────────────────────────────────────────────────────────

router.get("/marketing/segments", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const segments = await db
    .select()
    .from(marketingSegmentsTable)
    .where(eq(marketingSegmentsTable.workspaceId, workspaceId))
    .orderBy(desc(marketingSegmentsTable.updatedAt));
  res.json(segments.map(s => ({
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  })));
});

router.post("/marketing/segments", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { name, description, filters, pinnedClients, excludedClientIds } = req.body as {
    name: string; description?: string; filters?: FilterRule[];
    pinnedClients?: Array<{ id: number; name: string; phone: string | null }>;
    excludedClientIds?: number[];
  };
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const [seg] = await db.insert(marketingSegmentsTable).values({
    workspaceId,
    name,
    description: description ?? null,
    filters: filters ?? [],
    pinnedClients: pinnedClients ?? [],
    excludedClientIds: excludedClientIds ?? [],
    createdBy: req.clerkUserId ?? null,
  }).returning();
  res.status(201).json({ ...seg, createdAt: seg.createdAt.toISOString(), updatedAt: seg.updatedAt.toISOString() });
});

router.patch("/marketing/segments/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { name, description, filters, pinnedClients, excludedClientIds } = req.body as {
    name?: string; description?: string; filters?: FilterRule[];
    pinnedClients?: Array<{ id: number; name: string; phone: string | null }>;
    excludedClientIds?: number[];
  };
  const [updated] = await db
    .update(marketingSegmentsTable)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(filters !== undefined ? { filters } : {}),
      ...(pinnedClients !== undefined ? { pinnedClients } : {}),
      ...(excludedClientIds !== undefined ? { excludedClientIds } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(marketingSegmentsTable.id, id), eq(marketingSegmentsTable.workspaceId, workspaceId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() });
});

router.delete("/marketing/segments/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(marketingSegmentsTable).where(
    and(eq(marketingSegmentsTable.id, id), eq(marketingSegmentsTable.workspaceId, workspaceId))
  );
  res.status(204).send();
});

router.post("/marketing/segments/:id/duplicate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [source] = await db.select().from(marketingSegmentsTable).where(
    and(eq(marketingSegmentsTable.id, id), eq(marketingSegmentsTable.workspaceId, workspaceId))
  );
  if (!source) { res.status(404).json({ error: "Not found" }); return; }
  const [dup] = await db.insert(marketingSegmentsTable).values({
    workspaceId,
    name: `${source.name} (copia)`,
    description: source.description,
    filters: source.filters,
    pinnedClients: source.pinnedClients ?? [],
    excludedClientIds: source.excludedClientIds ?? [],
    createdBy: req.clerkUserId ?? null,
  }).returning();
  res.status(201).json({ ...dup, createdAt: dup.createdAt.toISOString(), updatedAt: dup.updatedAt.toISOString() });
});

// ─── Preview ──────────────────────────────────────────────────────────────────

router.post("/marketing/segments/preview", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { filters = [] } = req.body as { filters?: FilterRule[] };

  // Evaluate segment filters and return stats
  const result = await evaluateSegment(workspaceId, filters);
  res.json(result);
});

// Preview by saved segment id — applies pinned/excluded overrides
router.get("/marketing/segments/:id/preview", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [seg] = await db.select().from(marketingSegmentsTable).where(
    and(eq(marketingSegmentsTable.id, id), eq(marketingSegmentsTable.workspaceId, workspaceId))
  );
  if (!seg) { res.status(404).json({ error: "Not found" }); return; }
  const result = await evaluateSegment(workspaceId, seg.filters, {
    pinnedClients: (seg.pinnedClients as any[]) ?? [],
    excludedClientIds: (seg.excludedClientIds as any[]) ?? [],
  });
  res.json(result);
});

// ─── Segment evaluation engine ────────────────────────────────────────────────

type PreviewResult = {
  total: number;
  withoutPhone: number;
  duplicates: number;
  valid: number;
  clients?: Array<{ id: number; name: string; phone: string | null; activityIndex?: string; commercialScore?: number }>;
};

const PROFILE_FIELDS = new Set(["activityIndex", "commercialScore", "interest", "lastCommercialAction"]);

/**
 * Shared filter condition builder used by both evaluateSegment (preview) and
 * evaluateSegmentFull (campaign expansion) to guarantee identical results.
 * Mutates the `conditions` array in-place.
 */
function _applyFilterConditions(conditions: any[], filters: FilterRule[], workspaceId: number): void {
  for (const f of filters) {
    const v = f.value;
    switch (f.field) {
      case "province":
        if (f.operator === "eq" && v) conditions.push(eq(clientsTable.province, v as string));
        else if (f.operator === "neq" && v) conditions.push(sql`(${clientsTable.province} != ${v as string} OR ${clientsTable.province} IS NULL)`);
        else if (f.operator === "contains" && v) conditions.push(ilike(clientsTable.province, `%${v}%`));
        break;
      case "city":
        if (f.operator === "eq" && v) conditions.push(eq(clientsTable.city, v as string));
        else if (f.operator === "contains" && v) conditions.push(ilike(clientsTable.city, `%${v}%`));
        break;
      case "country":
        if (f.operator === "eq" && v) conditions.push(eq(clientsTable.country, v as string));
        else if (f.operator === "contains" && v) conditions.push(ilike(clientsTable.country, `%${v}%`));
        break;
      case "priority":
        if (f.operator === "eq" && v) conditions.push(eq(clientsTable.priority, v as string));
        else if (f.operator === "neq" && v) conditions.push(sql`(${clientsTable.priority} != ${v as string} OR ${clientsTable.priority} IS NULL)`);
        break;
      case "stage":
        if (f.operator === "eq" && v) conditions.push(eq(clientsTable.stage, v as string));
        else if (f.operator === "contains" && v) conditions.push(ilike(clientsTable.stage, `%${v}%`));
        break;
      case "tags":
        if (v) conditions.push(sql`${clientsTable.tags} @> ARRAY[${v as string}]::text[]`);
        break;
      case "activityIndex":
        if (f.operator === "eq" && v) conditions.push(sql`cp.activity_index = ${v as string}`);
        else if (f.operator === "neq" && v) conditions.push(sql`(cp.activity_index != ${v as string} OR cp.activity_index IS NULL)`);
        break;
      case "commercialScore":
        if (f.operator === "gte" && v !== null) conditions.push(sql`COALESCE(cp.commercial_score, 0) >= ${v as number}`);
        else if (f.operator === "lte" && v !== null) conditions.push(sql`COALESCE(cp.commercial_score, 0) <= ${v as number}`);
        break;
      case "interest":
        if (v) conditions.push(sql`cp.detected_interests @> ${JSON.stringify([v])}::jsonb`);
        break;
      case "lastCommercialAction":
        if (f.operator === "eq" && v) conditions.push(sql`cp.last_commercial_action = ${v as string}`);
        break;
      case "hasConversations":
        if (f.operator === "is_true") {
          conditions.push(exists(db.select({ _: sql`1` }).from(conversationsTable).where(eq(conversationsTable.clientId, clientsTable.id))));
        } else {
          conditions.push(sql`NOT EXISTS (SELECT 1 FROM conversations WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId})`);
        }
        break;
      case "hasTasks":
        if (f.operator === "is_true") {
          conditions.push(exists(db.select({ _: sql`1` }).from(tasksTable).where(and(eq(tasksTable.clientId, clientsTable.id), sql`status != 'completada'`))));
        } else {
          conditions.push(sql`NOT EXISTS (SELECT 1 FROM tasks WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND status != 'completada')`);
        }
        break;
      case "hasOpportunities":
        if (f.operator === "is_true") {
          conditions.push(exists(db.select({ _: sql`1` }).from(opportunitiesTable).where(and(eq(opportunitiesTable.clientId, clientsTable.id), eq(opportunitiesTable.outcome, "open")))));
        } else {
          conditions.push(sql`NOT EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'open')`);
        }
        break;
      case "hasWonOpportunities":
        if (f.operator === "is_true") {
          conditions.push(sql`EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'won')`);
        } else {
          conditions.push(sql`NOT EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'won')`);
        }
        break;
      case "hasLostOpportunities":
        if (f.operator === "is_true") {
          conditions.push(sql`EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'lost')`);
        } else {
          conditions.push(sql`NOT EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'lost')`);
        }
        break;
      case "opportunityOutcome":
        // Filter by specific outcome value: "won", "lost", or "open"
        if (v) conditions.push(sql`EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = ${v as string})`);
        break;
      case "wonValue": {
        // Filter by total won opportunity value (e.g. clients who closed > $X)
        const val = Number(v);
        if (!isNaN(val)) {
          if (f.operator === "gte") conditions.push(sql`(SELECT COALESCE(SUM(value),0) FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'won') >= ${val}`);
          else if (f.operator === "lte") conditions.push(sql`(SELECT COALESCE(SUM(value),0) FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND outcome = 'won') <= ${val}`);
        }
        break;
      }
      case "lastConversationDays": {
        const days = Number(v);
        if (!isNaN(days)) {
          if (f.operator === "lt_days") {
            conditions.push(sql`EXISTS (SELECT 1 FROM conversations WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND last_message_at >= NOW() - INTERVAL '1 day' * ${days})`);
          } else if (f.operator === "gt_days") {
            conditions.push(sql`NOT EXISTS (SELECT 1 FROM conversations WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND last_message_at >= NOW() - INTERVAL '1 day' * ${days})`);
          }
        }
        break;
      }
      case "lastTaskDays": {
        const days = Number(v);
        if (!isNaN(days)) {
          if (f.operator === "lt_days") {
            conditions.push(sql`EXISTS (SELECT 1 FROM tasks WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND created_at >= NOW() - INTERVAL '1 day' * ${days})`);
          } else if (f.operator === "gt_days") {
            conditions.push(sql`NOT EXISTS (SELECT 1 FROM tasks WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND created_at >= NOW() - INTERVAL '1 day' * ${days})`);
          }
        }
        break;
      }
      case "lastOpportunityDays": {
        const days = Number(v);
        if (!isNaN(days)) {
          if (f.operator === "lt_days") {
            conditions.push(sql`EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND created_at >= NOW() - INTERVAL '1 day' * ${days})`);
          } else if (f.operator === "gt_days") {
            conditions.push(sql`NOT EXISTS (SELECT 1 FROM opportunities WHERE client_id = ${clientsTable.id} AND workspace_id = ${workspaceId} AND created_at >= NOW() - INTERVAL '1 day' * ${days})`);
          }
        }
        break;
      }
    }
  }
}

/**
 * Returns ALL matching clients for campaign expansion (no 50-row preview cap).
 * Uses the IDENTICAL filter engine as evaluateSegment so expansion and preview
 * always produce identical client sets.
 * Applies manual overrides: excludedClientIds are removed, pinnedClients are appended.
 */
export async function evaluateSegmentFull(
  workspaceId: number,
  filters: FilterRule[],
  opts?: {
    pinnedClients?: Array<{ id: number; name: string; phone: string | null }>;
    excludedClientIds?: number[];
  },
): Promise<Array<{ id: number; name: string; phone: string | null }>> {
  const needsProfile = filters.some((f) => PROFILE_FIELDS.has(f.field));
  let baseQuery = db
    .select({ id: clientsTable.id, name: clientsTable.name, phone: clientsTable.phone })
    .from(clientsTable)
    .$dynamic();
  if (needsProfile) {
    baseQuery = baseQuery.leftJoin(
      clientProfilesTable,
      and(eq(clientProfilesTable.clientId, clientsTable.id), eq(clientProfilesTable.workspaceId, workspaceId)),
    );
  }
  const conditions: any[] = [eq(clientsTable.workspaceId, workspaceId)];
  _applyFilterConditions(conditions, filters, workspaceId);
  const rows = await baseQuery.where(and(...conditions));

  const excluded = new Set(opts?.excludedClientIds ?? []);
  const pinned = opts?.pinnedClients ?? [];
  const pinnedIds = new Set(pinned.map((c) => c.id));

  // Remove excluded, then append pinned (deduped) at the end
  const filtered = rows.filter((r) => !excluded.has(r.id) && !pinnedIds.has(r.id));
  return [...filtered, ...pinned];
}

export async function evaluateSegment(
  workspaceId: number,
  filters: FilterRule[],
  opts?: {
    pinnedClients?: Array<{ id: number; name: string; phone: string | null }>;
    excludedClientIds?: number[];
  },
): Promise<PreviewResult> {
  const needsProfile = filters.some((f) => PROFILE_FIELDS.has(f.field));

  // Build base query
  let baseQuery = db
    .select({
      id: clientsTable.id,
      name: clientsTable.name,
      phone: clientsTable.phone,
      activityIndex: needsProfile ? clientProfilesTable.activityIndex : sql<string | null>`null`,
      commercialScore: needsProfile ? clientProfilesTable.commercialScore : sql<number | null>`null`,
    })
    .from(clientsTable)
    .$dynamic();

  if (needsProfile) {
    baseQuery = baseQuery.leftJoin(
      clientProfilesTable,
      and(
        eq(clientProfilesTable.clientId, clientsTable.id),
        eq(clientProfilesTable.workspaceId, workspaceId),
      ),
    );
  }

  // Build WHERE conditions using the shared filter engine
  const conditions: any[] = [eq(clientsTable.workspaceId, workspaceId)];
  _applyFilterConditions(conditions, filters, workspaceId);

  const rows = await baseQuery.where(and(...conditions));

  // Apply manual overrides
  const excluded = new Set(opts?.excludedClientIds ?? []);
  const pinned = (opts?.pinnedClients ?? []) as Array<{ id: number; name: string; phone: string | null }>;
  const pinnedIds = new Set(pinned.map((c) => c.id));

  const effectiveRows: Array<{ id: number; name: string; phone: string | null; activityIndex?: string | null; commercialScore?: number | null }> = [
    ...rows.filter((r) => !excluded.has(r.id) && !pinnedIds.has(r.id)),
    ...pinned.map((c) => ({ id: c.id, name: c.name, phone: c.phone, activityIndex: null, commercialScore: null })),
  ];

  // Compute stats on effective list
  const total = effectiveRows.length;
  const withPhone = effectiveRows.filter((r) => r.phone && r.phone.trim().length > 0);
  const withoutPhone = total - withPhone.length;

  // Detect duplicate phones
  const phoneCounts = new Map<string, number>();
  withPhone.forEach((r) => {
    const p = r.phone!.trim();
    phoneCounts.set(p, (phoneCounts.get(p) ?? 0) + 1);
  });
  const duplicates = [...phoneCounts.values()].reduce((acc, v) => acc + (v > 1 ? v - 1 : 0), 0);
  const valid = withPhone.length - duplicates;

  return {
    total,
    withoutPhone,
    duplicates,
    valid,
    clients: effectiveRows.slice(0, 50).map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      activityIndex: r.activityIndex ?? undefined,
      commercialScore: r.commercialScore ?? undefined,
    })),
  };
}

export default router;
