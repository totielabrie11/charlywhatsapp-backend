/**
 * Campaign Send & Recipient Management Routes — Fase 3
 *
 * All routes are workspace-scoped (req.workspaceId).
 * Uses only the campaign queue service (no direct WhatsApp calls here).
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  campaignRecipientsTable,
  campaignRunLogsTable,
  marketingCampaignsTable,
  clientsTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import {
  startCampaignQueue,
  pauseCampaignQueue,
  resumeCampaignQueue,
  cancelCampaignQueue,
  getCampaignProgress,
} from "../services/campaignQueue";
import { normalizePhone } from "../lib/phone";

// Use the canonical segment evaluator — same function used by the preview endpoint,
// ensuring campaign expansion and segment preview always produce identical client sets.
import { evaluateSegmentFull } from "./segments";

const router = Router();

// ─── Recipients ───────────────────────────────────────────────────────────────

// GET /marketing/campaigns/:id/recipients
router.get("/marketing/campaigns/:id/recipients", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const recipients = await db
    .select()
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.campaignId, id),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
    ))
    .orderBy(desc(campaignRecipientsTable.createdAt));

  res.json(recipients.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
  })));
});

// POST /marketing/campaigns/:id/expand — expand segment into recipients
router.post("/marketing/campaigns/:id/expand", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db.select().from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  const sendable = ["draft", "configuring", "ready", "paused", "scheduled"];
  if (!sendable.includes(campaign.status)) {
    res.status(409).json({ error: `No se puede expandir una campaña en estado "${campaign.status}"` });
    return;
  }

  // Get filters: either from req.body or from the campaign's linked segment
  const { filters: bodyFilters } = req.body as { filters?: any[] };

  let filters: any[] = bodyFilters ?? [];
  if (!filters.length && campaign.segmentId) {
    const { marketingSegmentsTable } = await import("@workspace/db");
    const [seg] = await db.select().from(marketingSegmentsTable).where(
      and(eq(marketingSegmentsTable.id, campaign.segmentId), eq(marketingSegmentsTable.workspaceId, workspaceId))
    );
    filters = (seg?.filters as any[]) ?? [];
  }

  // Re-fetch segment to get pinned/excluded overrides (if linked by segmentId)
  let pinnedClients: Array<{ id: number; name: string; phone: string | null }> = [];
  let excludedClientIds: number[] = [];
  if (campaign.segmentId) {
    const { marketingSegmentsTable: mst } = await import("@workspace/db");
    const [seg2] = await db.select().from(mst).where(
      and(eq(mst.id, campaign.segmentId), eq(mst.workspaceId, workspaceId))
    );
    if (seg2) {
      pinnedClients = (seg2.pinnedClients as any[]) ?? [];
      excludedClientIds = (seg2.excludedClientIds as any[]) ?? [];
    }
  }

  // evaluateSegmentFull uses the IDENTICAL filter engine as the preview endpoint
  // (same _applyFilterConditions helper), so campaign expansion and segment preview
  // always produce identical client sets, just without the 50-row preview cap.
  const allClients = await evaluateSegmentFull(workspaceId, filters, { pinnedClients, excludedClientIds });
  const allValid = allClients.filter((c) => c.phone && c.phone.trim().length > 0);

  // Clear existing pending recipients before re-expanding — workspace-scoped
  await db.delete(campaignRecipientsTable).where(
    and(
      eq(campaignRecipientsTable.campaignId, id),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
      eq(campaignRecipientsTable.status, "pending"),
    )
  );

  if (allValid.length === 0) {
    res.json({ added: 0, message: "No se encontraron clientes válidos con teléfono" });
    return;
  }

  // Insert recipients in batches of 100
  const batchSize = 100;
  let added = 0;
  for (let i = 0; i < allValid.length; i += batchSize) {
    const batch = allValid.slice(i, i + batchSize).map((c) => ({
      workspaceId,
      campaignId: id,
      clientId: c.id,
      phoneNumber: normalizePhone(c.phone!),
      clientName: c.name,
      status: "pending" as const,
    }));
    await db.insert(campaignRecipientsTable).values(batch);
    added += batch.length;
  }

  // Update campaign status and snapshot segment filters.
  // Scheduled campaigns keep their "scheduled" status so the auto-scheduler
  // can still fire them; all other campaigns advance to "configuring".
  const nextStatus = campaign.status === "scheduled" ? "scheduled" : "configuring";
  await db.update(marketingCampaignsTable).set({
    status: nextStatus,
    recipientCount: added,
    segmentFilter: filters.length ? { filters } : null,
    updatedAt: new Date(),
  }).where(eq(marketingCampaignsTable.id, id));

  res.json({ added, total: allClients.length, valid: allValid.length, invalid: allClients.length - allValid.length });
});

// POST /marketing/campaigns/:id/recipients/add — add clients manually
router.post("/marketing/campaigns/:id/recipients/add", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify campaign belongs to this workspace before any mutation
  const [campaign] = await db.select({ id: marketingCampaignsTable.id }).from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  const { clientIds } = req.body as { clientIds?: number[] };
  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    res.status(400).json({ error: "clientIds array is required" }); return;
  }

  const clients = await db.select().from(clientsTable).where(
    and(eq(clientsTable.workspaceId, workspaceId), inArray(clientsTable.id, clientIds))
  );

  const toInsert = clients
    .filter((c) => c.phone && c.phone.trim().length > 0)
    .map((c) => ({
      workspaceId,
      campaignId: id,
      clientId: c.id,
      phoneNumber: normalizePhone(c.phone!),
      clientName: c.name,
      status: "pending" as const,
    }));

  if (toInsert.length === 0) {
    res.status(400).json({ error: "Ningún cliente tiene teléfono válido" }); return;
  }

  await db.insert(campaignRecipientsTable).values(toInsert);
  res.json({ added: toInsert.length });
});

// POST /marketing/campaigns/:id/recipients/exclude
router.post("/marketing/campaigns/:id/recipients/exclude", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify campaign ownership before mutation
  const [campaign] = await db.select({ id: marketingCampaignsTable.id }).from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  const { recipientIds, clientIds } = req.body as { recipientIds?: number[]; clientIds?: number[] };

  if (recipientIds?.length) {
    await db.update(campaignRecipientsTable)
      .set({ status: "excluded" })
      .where(and(
        eq(campaignRecipientsTable.campaignId, id),
        eq(campaignRecipientsTable.workspaceId, workspaceId),
        inArray(campaignRecipientsTable.id, recipientIds),
      ));
  }

  if (clientIds?.length) {
    await db.update(campaignRecipientsTable)
      .set({ status: "excluded" })
      .where(and(
        eq(campaignRecipientsTable.campaignId, id),
        eq(campaignRecipientsTable.workspaceId, workspaceId),
        inArray(campaignRecipientsTable.clientId, clientIds),
      ));
  }

  res.json({ ok: true });
});

// ─── Queue control ─────────────────────────────────────────────────────────────

// POST /marketing/campaigns/:id/send — validate + start queue
router.post("/marketing/campaigns/:id/send", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { rateMs } = req.body as { rateMs?: number };
  const initiatedBy = req.clerkUserId ?? null;

  // Pre-flight validation
  const [campaign] = await db.select().from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }
  if (!campaign.templateSnapshot) {
    res.status(422).json({ error: "La campaña no tiene plantilla configurada" }); return;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.campaignId, id),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
      eq(campaignRecipientsTable.status, "pending"),
    ));

  if (count === 0) {
    res.status(422).json({ error: "No hay destinatarios pendientes. Expandí el segmento primero." }); return;
  }

  const result = await startCampaignQueue(id, workspaceId, { rateMs, initiatedBy });
  if (!result.ok) {
    res.status(422).json({ error: result.error }); return;
  }

  res.json({ ok: true, recipientsQueued: count });
});

// POST /marketing/campaigns/:id/pause
router.post("/marketing/campaigns/:id/pause", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await pauseCampaignQueue(id, workspaceId);
  if (!result.ok) { res.status(422).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// POST /marketing/campaigns/:id/resume
router.post("/marketing/campaigns/:id/resume", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await resumeCampaignQueue(id, workspaceId);
  if (!result.ok) { res.status(422).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// POST /marketing/campaigns/:id/cancel
router.post("/marketing/campaigns/:id/cancel", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await cancelCampaignQueue(id, workspaceId);
  res.json({ ok: result.ok });
});

// POST /marketing/campaigns/:id/retry-failed
router.post("/marketing/campaigns/:id/retry-failed", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Ownership pre-check — must verify before touching queue state
  const [campaignOwner] = await db
    .select({ id: marketingCampaignsTable.id })
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  if (!campaignOwner) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  const { rateMs } = req.body as { rateMs?: number };
  const result = await startCampaignQueue(id, workspaceId, { rateMs, retryFailed: true, initiatedBy: req.clerkUserId });
  if (!result.ok) { res.status(422).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// ─── Progress & history ───────────────────────────────────────────────────────

// GET /marketing/campaigns/:id/progress
router.get("/marketing/campaigns/:id/progress", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const progress = await getCampaignProgress(id, workspaceId);
  res.json(progress);
});

// GET /marketing/campaigns/:id/runs — execution history
router.get("/marketing/campaigns/:id/runs", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const runs = await db
    .select()
    .from(campaignRunLogsTable)
    .where(and(
      eq(campaignRunLogsTable.campaignId, id),
      eq(campaignRunLogsTable.workspaceId, workspaceId),
    ))
    .orderBy(desc(campaignRunLogsTable.startedAt));

  res.json(runs.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    durationSeconds: r.finishedAt
      ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)
      : null,
  })));
});

// GET /marketing/campaigns/:id/validate — pre-flight validation summary
router.get("/marketing/campaigns/:id/validate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db.select().from(marketingCampaignsTable).where(
    and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId))
  );
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }

  const issues: Array<{ severity: "error" | "warning"; message: string }> = [];

  // Check template
  if (!campaign.templateSnapshot) {
    issues.push({ severity: "error", message: "No tiene plantilla configurada" });
  } else {
    const snap = campaign.templateSnapshot as any;
    if (!snap.bodyText && (!snap.attachmentIds || snap.attachmentIds.length === 0)) {
      issues.push({ severity: "error", message: "La plantilla no tiene texto ni archivos adjuntos" });
    }
  }

  // Check recipients — workspace-scoped
  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where status = 'pending')::int`,
      excluded: sql<number>`count(*) filter (where status = 'excluded')::int`,
    })
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.campaignId, id),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
    ));

  if ((stats?.pending ?? 0) === 0) {
    issues.push({ severity: "error", message: "No hay destinatarios pendientes" });
  }

  // Check WhatsApp connection
  const { getStatus } = await import("../services/whatsapp");
  const waStatus = getStatus(workspaceId);
  if (waStatus.state !== "connected") {
    issues.push({ severity: "error", message: `WhatsApp desconectado (estado: ${waStatus.state})` });
  }

  const valid = issues.filter((i) => i.severity === "error").length === 0;

  res.json({
    valid,
    issues,
    recipientStats: {
      total: stats?.total ?? 0,
      pending: stats?.pending ?? 0,
      excluded: stats?.excluded ?? 0,
    },
    waState: waStatus.state,
    hasTemplate: !!campaign.templateSnapshot,
  });
});

export default router;
