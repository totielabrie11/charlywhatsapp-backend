import { Router } from "express";
import { db } from "@workspace/db";
import {
  marketingCampaignsTable,
  marketingTemplatesTable,
  marketingAssetsTable,
  marketingSegmentsTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";

const router = Router();

// ─── Assets ──────────────────────────────────────────────────────────────────

router.get("/marketing/assets", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const assets = await db
    .select()
    .from(marketingAssetsTable)
    .where(eq(marketingAssetsTable.workspaceId, workspaceId))
    .orderBy(desc(marketingAssetsTable.createdAt));
  res.json(assets.map(a => ({ ...a, createdAt: a.createdAt.toISOString() })));
});

router.post("/marketing/assets", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const clerkUserId = req.clerkUserId ?? null;
  const { name, mimeType, size, url, thumbnailUrl } = req.body as {
    name: string; mimeType: string; size: number; url: string; thumbnailUrl?: string;
  };
  if (!name || !mimeType || !url) { res.status(400).json({ error: "name, mimeType and url are required" }); return; }
  const [asset] = await db.insert(marketingAssetsTable).values({
    workspaceId, name, mimeType, size: size ?? 0, url, thumbnailUrl: thumbnailUrl ?? null, uploadedBy: clerkUserId,
  }).returning();
  res.status(201).json({ ...asset, createdAt: asset.createdAt.toISOString() });
});

router.delete("/marketing/assets/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(marketingAssetsTable).where(
    and(eq(marketingAssetsTable.id, id), eq(marketingAssetsTable.workspaceId, workspaceId))
  );
  res.status(204).send();
});

// PATCH /marketing/assets/:id — rename asset
router.patch("/marketing/assets/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  const [updated] = await db
    .update(marketingAssetsTable)
    .set({ name: name.trim() })
    .where(and(eq(marketingAssetsTable.id, id), eq(marketingAssetsTable.workspaceId, workspaceId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

// POST /marketing/assets/:id/duplicate — clone asset record
router.post("/marketing/assets/:id/duplicate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [source] = await db.select().from(marketingAssetsTable).where(
    and(eq(marketingAssetsTable.id, id), eq(marketingAssetsTable.workspaceId, workspaceId))
  );
  if (!source) { res.status(404).json({ error: "Not found" }); return; }
  const [dup] = await db.insert(marketingAssetsTable).values({
    workspaceId,
    name: `${source.name} (copia)`,
    mimeType: source.mimeType,
    size: source.size,
    url: source.url,
    thumbnailUrl: source.thumbnailUrl ?? null,
    uploadedBy: req.clerkUserId ?? null,
  }).returning();
  res.status(201).json({ ...dup, createdAt: dup.createdAt.toISOString() });
});

// GET /marketing/assets/:id/usage — how many campaigns reference this asset
router.get("/marketing/assets/:id/usage", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Count campaigns whose templateSnapshot.attachmentIds includes this asset id
  const campaigns = await db
    .select({ id: marketingCampaignsTable.id, name: marketingCampaignsTable.name })
    .from(marketingCampaignsTable)
    .where(and(
      eq(marketingCampaignsTable.workspaceId, workspaceId),
      sql`template_snapshot->'attachmentIds' @> ${JSON.stringify([id])}::jsonb`,
    ));
  res.json({ assetId: id, usageCount: campaigns.length, campaigns: campaigns.map(c => ({ id: c.id, name: c.name })) });
});

// ─── Templates ────────────────────────────────────────────────────────────────

router.get("/marketing/templates", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const templates = await db
    .select()
    .from(marketingTemplatesTable)
    .where(eq(marketingTemplatesTable.workspaceId, workspaceId))
    .orderBy(desc(marketingTemplatesTable.updatedAt));
  res.json(templates.map(t => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  })));
});

router.post("/marketing/templates", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const clerkUserId = req.clerkUserId ?? null;
  const { name, bodyText, attachmentIds } = req.body as {
    name: string; bodyText?: string; attachmentIds?: number[];
  };
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const [tmpl] = await db.insert(marketingTemplatesTable).values({
    workspaceId,
    name,
    bodyText: bodyText ?? "",
    attachmentIds: attachmentIds ?? [],
    version: 1,
    createdBy: clerkUserId,
  }).returning();
  res.status(201).json({ ...tmpl, createdAt: tmpl.createdAt.toISOString(), updatedAt: tmpl.updatedAt.toISOString() });
});

router.patch("/marketing/templates/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(marketingTemplatesTable).where(
    and(eq(marketingTemplatesTable.id, id), eq(marketingTemplatesTable.workspaceId, workspaceId))
  );
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const { name, bodyText, attachmentIds } = req.body as {
    name?: string; bodyText?: string; attachmentIds?: number[];
  };

  const [updated] = await db
    .update(marketingTemplatesTable)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(attachmentIds !== undefined ? { attachmentIds } : {}),
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(marketingTemplatesTable.id, id), eq(marketingTemplatesTable.workspaceId, workspaceId)))
    .returning();
  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() });
});

router.delete("/marketing/templates/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(marketingTemplatesTable).where(
    and(eq(marketingTemplatesTable.id, id), eq(marketingTemplatesTable.workspaceId, workspaceId))
  );
  res.status(204).send();
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

router.get("/marketing/campaigns", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const campaigns = await db
    .select()
    .from(marketingCampaignsTable)
    .where(eq(marketingCampaignsTable.workspaceId, workspaceId))
    .orderBy(desc(marketingCampaignsTable.createdAt));
  res.json(campaigns.map(c => ({
    ...c,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    scheduledTimezone: c.scheduledTimezone ?? null,
    sentAt: c.sentAt?.toISOString() ?? null,
  })));
});

router.post("/marketing/campaigns", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const clerkUserId = req.clerkUserId ?? null;
  const { name, description, status, templateId, scheduledAt, color, objective, internalNotes, segmentId } = req.body as {
    name: string; description?: string; status?: string;
    templateId?: number; scheduledAt?: string;
    color?: string; objective?: string; internalNotes?: string; segmentId?: number;
  };
  if (!name) { res.status(400).json({ error: "name is required" }); return; }

  // Capture template snapshot for versionado
  let templateSnapshot: TemplateSnapshot | null = null;
  if (templateId) {
    const [tmpl] = await db.select().from(marketingTemplatesTable).where(
      and(eq(marketingTemplatesTable.id, templateId), eq(marketingTemplatesTable.workspaceId, workspaceId))
    );
    if (tmpl) {
      templateSnapshot = {
        name: tmpl.name,
        bodyText: tmpl.bodyText,
        attachmentIds: tmpl.attachmentIds,
        version: tmpl.version,
        capturedAt: new Date().toISOString(),
      };
    }
  }

  const [campaign] = await db.insert(marketingCampaignsTable).values({
    workspaceId,
    name,
    description: description ?? null,
    status: (status as any) ?? "draft",
    templateId: templateId ?? null,
    templateSnapshot,
    segmentId: segmentId ?? null,
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    color: color ?? null,
    objective: objective ?? null,
    internalNotes: internalNotes ?? null,
    createdBy: clerkUserId,
  }).returning();

  res.status(201).json({
    ...campaign,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    sentAt: campaign.sentAt?.toISOString() ?? null,
  });
});

// POST /marketing/campaigns/:id/duplicate — clone a campaign
router.post("/marketing/campaigns/:id/duplicate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [source] = await db.select().from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!source) { res.status(404).json({ error: "Not found" }); return; }
  const [dup] = await db.insert(marketingCampaignsTable).values({
    workspaceId,
    name: `${source.name} (copia)`,
    description: source.description,
    status: "draft",
    templateId: source.templateId,
    templateSnapshot: source.templateSnapshot,
    segmentId: source.segmentId,
    color: source.color,
    objective: source.objective,
    internalNotes: source.internalNotes,
    createdBy: req.clerkUserId ?? null,
  }).returning();
  res.status(201).json({
    ...dup,
    createdAt: dup.createdAt.toISOString(),
    updatedAt: dup.updatedAt.toISOString(),
    scheduledAt: null,
    sentAt: null,
  });
});

router.patch("/marketing/campaigns/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const { name, description, status, templateId, scheduledAt, color, objective, internalNotes, segmentId } = req.body as {
    name?: string; description?: string; status?: string;
    templateId?: number; scheduledAt?: string;
    color?: string; objective?: string; internalNotes?: string; segmentId?: number;
  };

  // Always re-snapshot from the live template so edits to the template are reflected
  // immediately in the campaign (before sending). Once a campaign is sent, the snapshot
  // is frozen in history and we no longer update it on PATCH.
  const resolvedTemplateId = templateId !== undefined ? templateId : existing.templateId;
  let templateSnapshot = existing.templateSnapshot as TemplateSnapshot | null;
  if (resolvedTemplateId && !["sent", "sending"].includes(existing.status ?? "")) {
    const [tmpl] = await db.select().from(marketingTemplatesTable).where(
      and(eq(marketingTemplatesTable.id, resolvedTemplateId), eq(marketingTemplatesTable.workspaceId, workspaceId))
    );
    if (tmpl) {
      templateSnapshot = {
        name: tmpl.name,
        bodyText: tmpl.bodyText,
        attachmentIds: tmpl.attachmentIds,
        version: tmpl.version,
        capturedAt: new Date().toISOString(),
      };
    }
  }

  const [updated] = await db
    .update(marketingCampaignsTable)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(objective !== undefined ? { objective } : {}),
      ...(internalNotes !== undefined ? { internalNotes } : {}),
      ...(segmentId !== undefined ? { segmentId } : {}),
      templateId: resolvedTemplateId,
      templateSnapshot,
      ...(scheduledAt !== undefined ? { scheduledAt: new Date(scheduledAt) } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)))
    .returning();

  res.json({
    ...updated,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    scheduledAt: updated.scheduledAt?.toISOString() ?? null,
    sentAt: updated.sentAt?.toISOString() ?? null,
  });
});

router.delete("/marketing/campaigns/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  res.status(204).send();
});

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get("/marketing/stats", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { campaignRecipientsTable } = await import("@workspace/db");

  const [campaigns, templates, assets, recipientStats, segmentCount] = await Promise.all([
    db.select().from(marketingCampaignsTable).where(eq(marketingCampaignsTable.workspaceId, workspaceId)),
    db.select({ id: marketingTemplatesTable.id }).from(marketingTemplatesTable).where(eq(marketingTemplatesTable.workspaceId, workspaceId)),
    db.select({ id: marketingAssetsTable.id }).from(marketingAssetsTable).where(eq(marketingAssetsTable.workspaceId, workspaceId)),
    db.select({
      totalSent: sql<number>`count(*) filter (where status = 'sent')::int`,
      totalFailed: sql<number>`count(*) filter (where status = 'failed')::int`,
      clientsReached: sql<number>`count(distinct client_id) filter (where status = 'sent')::int`,
    }).from(campaignRecipientsTable).where(eq(campaignRecipientsTable.workspaceId, workspaceId)),
    db.select({ count: sql<number>`count(*)::int` }).from(marketingSegmentsTable).where(eq(marketingSegmentsTable.workspaceId, workspaceId)),
  ]);

  const rStats = recipientStats[0];
  const activeCampaigns = campaigns.filter(c => c.status === "sending" || c.status === "paused").length;
  const finishedCampaigns = campaigns.filter(c => c.status === "finished").length;
  const lastCampaign = campaigns.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

  res.json({
    totalCampaigns: campaigns.length,
    activeCampaigns,
    finishedCampaigns,
    scheduledCampaigns: campaigns.filter(c => c.status === "scheduled").length,
    sentCampaigns: campaigns.filter(c => c.status === "finished").length,
    totalSent: rStats?.totalSent ?? 0,
    totalFailed: rStats?.totalFailed ?? 0,
    clientsReached: rStats?.clientsReached ?? 0,
    totalTemplates: templates.length,
    totalAssets: assets.length,
    totalSegments: segmentCount[0]?.count ?? 0,
    lastCampaign: lastCampaign ? { id: lastCampaign.id, name: lastCampaign.name, status: lastCampaign.status } : null,
  });
});

// ─── Local types ─────────────────────────────────────────────────────────────
type TemplateSnapshot = {
  name: string;
  bodyText: string;
  attachmentIds: number[];
  version: number;
  capturedAt: string;
};

export default router;
