/**
 * Campaign Schedule & Event History Routes — Fase 4
 *
 * POST   /marketing/campaigns/:id/schedule      — schedule a campaign
 * DELETE /marketing/campaigns/:id/schedule      — cancel scheduling
 * GET    /marketing/campaigns/:id/events        — event history
 * DELETE /marketing/campaigns/:id/recipients/:recipientId — remove one recipient
 * POST   /marketing/campaigns/:id/recipients/single      — add one client
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  marketingCampaignsTable,
  campaignEventsTable,
  campaignRecipientsTable,
  clientsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { writeCampaignEvent } from "../services/schedulerService";
import { normalizePhone } from "../lib/phone";

const router = Router();

// ─── Schedule a campaign ──────────────────────────────────────────────────────

/**
 * POST /marketing/campaigns/:id/schedule
 * Body: { scheduledDate: "YYYY-MM-DD", scheduledTime: "HH:mm", timezone: "America/Argentina/Buenos_Aires" }
 * Computes scheduledAt in UTC and sets status = "scheduled".
 */
router.post("/marketing/campaigns/:id/schedule", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { scheduledDate, scheduledTime, timezone } = req.body as {
    scheduledDate?: string;
    scheduledTime?: string;
    timezone?: string;
  };

  if (!scheduledDate || !scheduledTime) {
    res.status(400).json({ error: "scheduledDate and scheduledTime are required" }); return;
  }

  const [campaign] = await db
    .select()
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)));

  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  // Sending or already sent campaigns cannot be rescheduled
  const blocked = ["sending", "finished", "cancelled"];
  if (blocked.includes(campaign.status)) {
    res.status(409).json({ error: `No se puede programar una campaña en estado "${campaign.status}"` }); return;
  }

  // Parse date+time in the given timezone using the Intl API (no extra deps)
  // Strategy: interpret the local datetime string as if it's in `timezone`,
  // then convert to UTC via Date.
  const localStr = `${scheduledDate}T${scheduledTime}:00`;
  let scheduledAt: Date;
  try {
    // Use the Temporal-like trick: build a formatter for the target tz,
    // compute the UTC offset at that local time, then apply it.
    const tz = timezone ?? "UTC";
    // Parse as UTC first, then correct for the timezone offset
    const tempDate = new Date(`${localStr}Z`);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(tempDate).map(p => [p.type, p.value])
    );
    const tzDate = new Date(
      `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"] === "24" ? "00" : parts["hour"]}:${parts["minute"]}:${parts["second"]}Z`
    );
    const offsetMs = tzDate.getTime() - tempDate.getTime();
    scheduledAt = new Date(tempDate.getTime() - offsetMs);
  } catch {
    res.status(400).json({ error: "Zona horaria inválida" }); return;
  }

  if (scheduledAt <= new Date()) {
    res.status(400).json({ error: "La fecha/hora programada debe ser en el futuro" }); return;
  }

  const wasScheduled = campaign.status === "scheduled";
  const actor = req.clerkUserId ?? "user";

  await db
    .update(marketingCampaignsTable)
    .set({ status: "scheduled", scheduledAt, scheduledTimezone: timezone ?? "UTC", updatedAt: new Date() })
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)));

  await writeCampaignEvent(
    id,
    workspaceId,
    wasScheduled ? "schedule_changed" : "scheduled",
    wasScheduled
      ? `Horario cambiado a ${scheduledAt.toISOString()} (${timezone ?? "UTC"})`
      : `Campaña programada para ${scheduledAt.toISOString()} (${timezone ?? "UTC"})`,
    actor,
  );

  const [updated] = await db
    .select()
    .from(marketingCampaignsTable)
    .where(eq(marketingCampaignsTable.id, id));

  res.json({
    ...updated,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    scheduledAt: updated.scheduledAt?.toISOString() ?? null,
    sentAt: updated.sentAt?.toISOString() ?? null,
  });
});

// ─── Cancel scheduling ────────────────────────────────────────────────────────

/**
 * DELETE /marketing/campaigns/:id/schedule
 * Reverts the campaign to "ready" status and clears scheduledAt.
 */
router.delete("/marketing/campaigns/:id/schedule", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db
    .select({ id: marketingCampaignsTable.id, status: marketingCampaignsTable.status })
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)));

  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }
  if (campaign.status !== "scheduled") {
    res.status(409).json({ error: "La campaña no está programada" }); return;
  }

  await db
    .update(marketingCampaignsTable)
    .set({ status: "ready", scheduledAt: null, updatedAt: new Date() })
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)));

  await writeCampaignEvent(id, workspaceId, "schedule_cancelled", "Programación cancelada", req.clerkUserId ?? "user");

  res.json({ ok: true });
});

// ─── Event history ────────────────────────────────────────────────────────────

/**
 * GET /marketing/campaigns/:id/events
 * Returns the event log for a campaign, ordered newest-first.
 */
router.get("/marketing/campaigns/:id/events", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify ownership
  const [campaign] = await db
    .select({ id: marketingCampaignsTable.id })
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, id), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  const events = await db
    .select()
    .from(campaignEventsTable)
    .where(and(
      eq(campaignEventsTable.campaignId, id),
      eq(campaignEventsTable.workspaceId, workspaceId),
    ))
    .orderBy(desc(campaignEventsTable.createdAt));

  res.json(events.map(e => ({
    ...e,
    createdAt: e.createdAt.toISOString(),
  })));
});

// ─── Recipient management ─────────────────────────────────────────────────────

/**
 * DELETE /marketing/campaigns/:id/recipients/:recipientId
 * Removes a single pending recipient row (hard delete — recipient was not sent).
 */
router.delete("/marketing/campaigns/:id/recipients/:recipientId", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const campaignId = parseInt(req.params.id, 10);
  const recipientId = parseInt(req.params.recipientId, 10);
  if (isNaN(campaignId) || isNaN(recipientId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  // Verify campaign ownership
  const [campaign] = await db
    .select({ id: marketingCampaignsTable.id, status: marketingCampaignsTable.status })
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  if (["sending", "finished", "cancelled"].includes(campaign.status)) {
    res.status(409).json({ error: "No se puede modificar los destinatarios en este estado" }); return;
  }

  const [recipient] = await db
    .select({ id: campaignRecipientsTable.id, clientName: campaignRecipientsTable.clientName, status: campaignRecipientsTable.status })
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.id, recipientId),
      eq(campaignRecipientsTable.campaignId, campaignId),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
    ));

  if (!recipient) { res.status(404).json({ error: "Destinatario no encontrado" }); return; }
  if (recipient.status === "sent") {
    res.status(409).json({ error: "No se puede eliminar un destinatario ya enviado" }); return;
  }

  await db
    .delete(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.id, recipientId),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
    ));

  await writeCampaignEvent(
    campaignId,
    workspaceId,
    "schedule_changed",
    `Destinatario eliminado: ${recipient.clientName}`,
    req.clerkUserId ?? "user",
  );

  res.json({ ok: true });
});

/**
 * POST /marketing/campaigns/:id/recipients/single
 * Adds a single client as a pending recipient (append-only, no segment recalculation).
 * Body: { clientId: number }
 */
router.post("/marketing/campaigns/:id/recipients/single", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const campaignId = parseInt(req.params.id, 10);
  if (isNaN(campaignId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { clientId } = req.body as { clientId?: number };
  if (!clientId) { res.status(400).json({ error: "clientId is required" }); return; }

  const [campaign] = await db
    .select({ id: marketingCampaignsTable.id, status: marketingCampaignsTable.status })
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  if (!campaign) { res.status(404).json({ error: "Campaña no encontrada" }); return; }

  if (["sending", "finished", "cancelled"].includes(campaign.status)) {
    res.status(409).json({ error: "No se puede agregar destinatarios en este estado" }); return;
  }

  const [client] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.workspaceId, workspaceId)));
  if (!client) { res.status(404).json({ error: "Cliente no encontrado" }); return; }
  if (!client.phone?.trim()) {
    res.status(400).json({ error: "El cliente no tiene número de teléfono" }); return;
  }

  const [inserted] = await db
    .insert(campaignRecipientsTable)
    .values({
      workspaceId,
      campaignId,
      clientId: client.id,
      phoneNumber: normalizePhone(client.phone),
      clientName: client.name,
      status: "pending",
    })
    .returning();

  await writeCampaignEvent(
    campaignId,
    workspaceId,
    "schedule_changed",
    `Destinatario agregado: ${client.name}`,
    req.clerkUserId ?? "user",
  );

  res.status(201).json({
    ...inserted,
    createdAt: inserted.createdAt.toISOString(),
    sentAt: null,
  });
});

export default router;
