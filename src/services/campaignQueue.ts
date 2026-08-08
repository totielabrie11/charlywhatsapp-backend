/**
 * Campaign Send Queue — Fase 3
 *
 * In-memory queue that processes campaign recipients sequentially with a
 * configurable rate limit. Uses ONLY the existing sendMessage / sendMediaMessage
 * functions from whatsapp.ts — no new WhatsApp connections are created.
 *
 * Constraints:
 * - Never touches Baileys directly
 * - Never modifies the WhatsApp module
 * - All DB writes are additive to campaign_recipients / campaign_run_logs / marketing_campaigns
 */

import { db } from "@workspace/db";
import {
  campaignRecipientsTable,
  campaignRunLogsTable,
  marketingCampaignsTable,
  marketingAssetsTable,
  clientsTable,
  conversationsTable,
  messagesTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { emit } from "../lib/socket";
import { logClientEvent } from "./clientEvents";
import { sendMessage, sendMediaMessage, getStatus } from "./whatsapp";
import { substituteVariables } from "./templateVariables";
import { normalizePhone } from "../lib/phone";

// ─── Rate limiting config ──────────────────────────────────────────────────────
/** Default delay between sends in milliseconds (configurable via API). */
const DEFAULT_RATE_MS = 3000;
/** Minimum allowed delay to avoid WhatsApp bans */
const MIN_RATE_MS = 1000;

// ─── In-memory queue state (per campaign) ─────────────────────────────────────
interface QueueEntry {
  workspaceId: number;   // owner — used to reject cross-workspace control attempts
  paused: boolean;
  cancelled: boolean;
  rateMs: number;
  /** Resolved after each send to allow graceful cancellation in progress */
  _sleeping: boolean;
}

const activeQueues = new Map<number, QueueEntry>();

function isRunning(campaignId: number): boolean {
  const e = activeQueues.get(campaignId);
  return !!e && !e.cancelled;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms: number, entry: QueueEntry): Promise<void> {
  entry._sleeping = true;
  const step = 100;
  let elapsed = 0;
  while (elapsed < ms) {
    if (entry.cancelled) { entry._sleeping = false; return; }
    await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
  entry._sleeping = false;
}

/**
 * Find the most recent conversation for a client phone number, or create a
 * minimal one so we can call the existing sendMessage() function.
 */
async function resolveConversationId(workspaceId: number, clientId: number | null | undefined, phone: string, clientName: string): Promise<number | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  // Try to find existing conversation
  const [existing] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.workspaceId, workspaceId),
      eq(conversationsTable.contactPhone, normalized),
    ))
    .limit(1);
  if (existing) return existing.id;

  // Create a minimal outbound conversation
  try {
    const [created] = await db
      .insert(conversationsTable)
      .values({
        workspaceId,
        contactName: clientName || normalized,
        contactPhone: normalized,
        whatsappJid: `${normalized}@s.whatsapp.net`,
        clientId: clientId ?? null,
        status: "active",
        lastMessage: "",
      })
      .onConflictDoUpdate({
        target: [conversationsTable.workspaceId, conversationsTable.contactPhone],
        set: { clientId: clientId ?? null },
      })
      .returning({ id: conversationsTable.id });
    return created?.id ?? null;
  } catch (e) {
    logger.warn({ err: e, phone, workspaceId }, "campaign: failed to resolve/create conversation");
    return null;
  }
}

/**
 * Extract base64 content from an asset URL.
 *
 * SECURITY: Only data URLs are accepted. External HTTP/HTTPS URL fetching is
 * intentionally disabled to prevent SSRF attacks — an authenticated user who
 * can create assets with arbitrary URL values must not be able to trigger
 * server-side HTTP requests to internal/private endpoints.
 *
 * Assets stored in this app are always data URLs (no Object Storage yet).
 * If Object Storage is added in future, this function must validate the URL
 * against a signed-URL pattern or an allowlisted CDN domain before fetching.
 */
function assetToBase64(url: string): { base64: string; mimeType: string } | null {
  // data URL format: data:{mimeType};base64,{data}
  const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return { mimeType: dataUrlMatch[1]!, base64: dataUrlMatch[2]! };
  }
  // All other URL formats (http:, https:, relative paths) are rejected.
  logger.warn({ urlPrefix: url.substring(0, 64) }, "campaign: asset is not a data URL — skipping (external fetch disabled)");
  return null;
}

/**
 * Determine media kind from MIME type for sendMediaMessage().
 */
function mediaKindFromMime(mimeType: string): "image" | "document" | "audio" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

// ─── Emit progress helper ─────────────────────────────────────────────────────

async function emitProgress(workspaceId: number, campaignId: number): Promise<void> {
  try {
    const [stats] = await db
      .select({
        sent: sql<number>`count(*) filter (where status = 'sent')`,
        failed: sql<number>`count(*) filter (where status = 'failed')`,
        pending: sql<number>`count(*) filter (where status = 'pending')`,
        excluded: sql<number>`count(*) filter (where status = 'excluded')`,
      })
      .from(campaignRecipientsTable)
      .where(and(
        eq(campaignRecipientsTable.campaignId, campaignId),
        eq(campaignRecipientsTable.workspaceId, workspaceId),
      ));

    const entry = activeQueues.get(campaignId);
    const rateMs = entry?.rateMs ?? DEFAULT_RATE_MS;
    const pending = stats?.pending ?? 0;
    const estimatedSecondsLeft = pending > 0 ? Math.ceil((pending * rateMs) / 1000) : 0;

    emit(workspaceId, "campaign:progress", {
      campaignId,
      sent: stats?.sent ?? 0,
      failed: stats?.failed ?? 0,
      pending,
      excluded: stats?.excluded ?? 0,
      estimatedSecondsLeft,
      paused: entry?.paused ?? false,
      running: isRunning(campaignId),
    });
  } catch (e) {
    logger.warn({ err: e, campaignId }, "emitProgress failed");
  }
}

// ─── Core queue processor ─────────────────────────────────────────────────────

async function processQueue(campaignId: number, workspaceId: number, runLogId: number): Promise<void> {
  const entry = activeQueues.get(campaignId);
  if (!entry) return;

  let totalSent = 0;
  let totalFailed = 0;

  // Fetch campaign (including template snapshot and settings)
  const [campaign] = await db
    .select()
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));

  if (!campaign) {
    activeQueues.delete(campaignId);
    return;
  }

  const snapshot = campaign.templateSnapshot as {
    name: string; bodyText: string; attachmentIds: number[]; version: number; capturedAt: string;
  } | null;

  // Fetch workspace display name for {{vendedor}} variable
  let vendedor = "";
  try {
    const { workspacesTable } = await import("@workspace/db");
    const [ws] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, workspaceId)).limit(1);
    vendedor = ws?.name ?? "";
  } catch (_) { /* ignore */ }

  // Explicit stop reason — prevents finalization logic from relying only on totalSent/totalFailed
  let stopReason: "completed" | "cancelled" | "disconnected" | "running" = "running";

  // Main processing loop
  while (true) {
    if (entry.cancelled) { stopReason = "cancelled"; break; }

    // Wait while paused
    while (entry.paused && !entry.cancelled) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (entry.cancelled) break;

    // Check WhatsApp connection
    const status = getStatus(workspaceId);
    if (status.state !== "connected") {
      // Pause queue — connection lost
      entry.paused = true;
      stopReason = "disconnected";
      emit(workspaceId, "campaign:progress", {
        campaignId,
        error: "WhatsApp desconectado — campaña pausada automáticamente",
        paused: true,
      });
      // Wait for reconnect (up to 2 minutes)
      let waited = 0;
      while (waited < 120_000 && !entry.cancelled) {
        await new Promise((r) => setTimeout(r, 2000));
        waited += 2000;
        const s2 = getStatus(workspaceId);
        if (s2.state === "connected") { entry.paused = false; stopReason = "running"; break; }
      }
      if (entry.paused) break; // give up — campaign will remain paused
    }

    // Get next pending recipient (always scoped by workspaceId to prevent cross-workspace reads)
    const [recipient] = await db
      .select()
      .from(campaignRecipientsTable)
      .where(and(
        eq(campaignRecipientsTable.campaignId, campaignId),
        eq(campaignRecipientsTable.workspaceId, workspaceId),
        eq(campaignRecipientsTable.status, "pending"),
      ))
      .limit(1);

    if (!recipient) { stopReason = "completed"; break; } // all done

    // Fetch client for variable substitution — always scoped by workspaceId
    let client: typeof clientsTable.$inferSelect | null = null;
    if (recipient.clientId) {
      const [c] = await db.select().from(clientsTable).where(
        and(eq(clientsTable.id, recipient.clientId), eq(clientsTable.workspaceId, workspaceId))
      );
      client = c ?? null;
    }

    // Resolve or create conversation
    const conversationId = await resolveConversationId(
      workspaceId,
      recipient.clientId,
      recipient.phoneNumber,
      recipient.clientName,
    );

    if (!conversationId) {
      await db.update(campaignRecipientsTable)
        .set({ status: "failed", error: "No se pudo resolver la conversación" })
        .where(eq(campaignRecipientsTable.id, recipient.id));
      totalFailed++;
      await emitProgress(workspaceId, campaignId);
      continue;
    }

    // Build substitution context from client (or fallback to recipient data)
    const subCtx = {
      name: client?.name ?? recipient.clientName,
      company: client?.company,
      phone: client?.phone ?? recipient.phoneNumber,
      city: client?.city,
      province: client?.province,
      vendedor,
    };

    try {
      // Send text body — then verify the message was actually delivered
      if (snapshot?.bodyText) {
        const text = substituteVariables(snapshot.bodyText, subCtx);
        const msgResult = await sendMessage(workspaceId, conversationId, text);
        // sendMessage catches Baileys errors internally and doesn't re-throw;
        // query the DB for the final status to detect failures reliably.
        const [finalMsg] = await db
          .select({ status: messagesTable.status })
          .from(messagesTable)
          .where(eq(messagesTable.id, msgResult.id));
        if (!finalMsg || finalMsg.status === "failed") {
          throw new Error(`Fallo al enviar mensaje de texto (estado: ${finalMsg?.status ?? "desconocido"})`);
        }
        if (finalMsg.status === "pending") {
          // WhatsApp disconnected mid-send — abort this recipient, pause queue
          throw new Error("WhatsApp desconectado durante el envío — campaña pausada");
        }
      }

      // Send all attachments (in order declared in the snapshot)
      if (snapshot?.attachmentIds?.length) {
        const attachmentIdList = snapshot.attachmentIds as number[];
        const assets = await db
          .select()
          .from(marketingAssetsTable)
          .where(
            and(
              inArray(marketingAssetsTable.id, attachmentIdList),
              eq(marketingAssetsTable.workspaceId, workspaceId),
            )
          );

        // Re-order to match the snapshot order
        const assetById = new Map(assets.map((a) => [a.id, a]));
        const orderedAssets = attachmentIdList.map((aid) => assetById.get(aid)).filter(Boolean) as typeof assets;

        for (const asset of orderedAssets) {
          const media = assetToBase64(asset.url);
          if (!media) {
            logger.warn({ assetId: asset.id, campaignId }, "campaign: asset is not a data URL — skipping");
            continue;
          }
          const kind = mediaKindFromMime(asset.mimeType ?? media.mimeType);
          const mediaResult = await sendMediaMessage(workspaceId, conversationId, kind, media.base64, media.mimeType, asset.name, undefined);
          // Verify media delivery
          const [finalMedia] = await db
            .select({ status: messagesTable.status })
            .from(messagesTable)
            .where(eq(messagesTable.id, mediaResult.id));
          // Treat both "failed" and "pending" as non-delivery (same logic as text sends)
          if (!finalMedia || finalMedia.status === "failed" || finalMedia.status === "pending") {
            throw new Error(`Fallo al enviar archivo adjunto "${asset.name}" (estado: ${finalMedia?.status ?? "desconocido"})`);
          }
        }
      }

      // Mark sent — only reached if ALL sends (text + attachments) succeeded
      await db.update(campaignRecipientsTable)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(campaignRecipientsTable.id, recipient.id));

      totalSent++;

      // Log client event
      if (recipient.clientId) {
        await logClientEvent({
          workspaceId,
          clientId: recipient.clientId,
          type: "message_sent",
          detail: `📣 Campaña: ${campaign.name}`,
          actor: "Marketing",
          relatedType: "campaign",
          relatedId: campaignId,
        });
      }

      // Update campaign counters
      await db.update(marketingCampaignsTable)
        .set({ sentCount: sql`sent_count + 1` })
        .where(eq(marketingCampaignsTable.id, campaignId));

    } catch (e: any) {
      const errorMsg = e?.message ?? "Error desconocido";
      logger.error({ err: e, campaignId, recipientId: recipient.id }, "campaign send error");

      await db.update(campaignRecipientsTable)
        .set({ status: "failed", error: errorMsg.substring(0, 500) })
        .where(eq(campaignRecipientsTable.id, recipient.id));

      totalFailed++;

      await db.update(marketingCampaignsTable)
        .set({ failedCount: sql`failed_count + 1` })
        .where(eq(marketingCampaignsTable.id, campaignId));
    }

    await emitProgress(workspaceId, campaignId);

    // Rate limiting delay (interruptible)
    await sleep(entry.rateMs, entry);
  }

  // ── Finalize ────────────────────────────────────────────────────────────────
  // Check whether any recipients are still pending — a non-zero count means the
  // queue was interrupted before completion (disconnect timeout, crash, etc.) and
  // the campaign must NOT be marked `finished`.
  const [pendingCheck] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.campaignId, campaignId),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
      eq(campaignRecipientsTable.status, "pending"),
    ));
  const remainingPending = pendingCheck?.remaining ?? 0;

  const finalStatus: string =
    stopReason === "cancelled"
      ? "cancelled"
      : remainingPending > 0
        // Queue exited with unsent recipients — interrupted (disconnect/crash)
        ? (totalFailed > 0 ? "with_errors" : "paused")
        // All recipients processed
        : totalFailed > 0
          ? "with_errors"
          : "finished";

  // Only set finishedAt when truly done; leave it null for paused campaigns
  const isTerminal = finalStatus !== "paused";

  await db.update(marketingCampaignsTable)
    .set({
      status: finalStatus,
      ...(isTerminal ? { finishedAt: new Date() } : {}),
    })
    .where(and(
      eq(marketingCampaignsTable.id, campaignId),
      eq(marketingCampaignsTable.workspaceId, workspaceId),
    ));

  // Close run log
  await db.update(campaignRunLogsTable)
    .set({ finishedAt: new Date(), totalSent, totalFailed })
    .where(eq(campaignRunLogsTable.id, runLogId));

  activeQueues.delete(campaignId);
  await emitProgress(workspaceId, campaignId);
  emit(workspaceId, "campaign:finished", { campaignId, status: finalStatus, totalSent, totalFailed });

  logger.info({ campaignId, workspaceId, totalSent, totalFailed, finalStatus }, "Campaign queue finished");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface StartQueueOptions {
  rateMs?: number;
  initiatedBy?: string | null;
  /** If true, only retry recipients with status = 'failed' */
  retryFailed?: boolean;
}

/**
 * Start or resume the send queue for a campaign.
 * Enforces single-run idempotency: returns an error if a processor is already
 * active for this campaign, preventing duplicate sends from concurrent requests.
 */
export async function startCampaignQueue(
  campaignId: number,
  workspaceId: number,
  opts: StartQueueOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  // ── Idempotency guard — atomic reservation ────────────────────────────────────
  // We reserve the slot in activeQueues IMMEDIATELY (before any await) so that
  // two concurrent /send requests for the same campaign both read the map in the
  // same JS event-loop turn and only one wins. The loser is rejected synchronously.
  // If validation fails afterwards, we release the slot before returning.
  const existingEntry = activeQueues.get(campaignId);
  if (existingEntry && !existingEntry.cancelled) {
    // Reject cross-workspace control attempts
    if (existingEntry.workspaceId !== workspaceId) {
      return { ok: false, error: "Campaña no encontrada" };
    }
    if (existingEntry.paused) {
      existingEntry.paused = false;
      return { ok: true };
    }
    return { ok: false, error: "Esta campaña ya está en ejecución" };
  }

  // Reserve the slot immediately — released on any validation failure below.
  // workspaceId is embedded so queue-control functions can reject cross-workspace callers.
  const reservedEntry: QueueEntry = {
    workspaceId,
    paused: false, cancelled: false, rateMs: Math.max(MIN_RATE_MS, opts.rateMs ?? DEFAULT_RATE_MS), _sleeping: false,
  };
  activeQueues.set(campaignId, reservedEntry);

  // Helper to release the reservation on failure
  const releaseSlot = (error: string): { ok: false; error: string } => {
    activeQueues.delete(campaignId);
    return { ok: false, error };
  };

  // Validate WhatsApp connection
  const status = getStatus(workspaceId);
  if (status.state !== "connected") {
    return releaseSlot("WhatsApp no conectado. Verificá la conexión antes de enviar.");
  }

  // Validate campaign exists and is in a sendable state
  const [campaign] = await db
    .select()
    .from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));

  if (!campaign) return releaseSlot("Campaña no encontrada");

  const sendableStatuses = ["ready", "paused", "with_errors", "draft", "configuring", "scheduled"];
  if (!sendableStatuses.includes(campaign.status)) {
    return releaseSlot(`La campaña está en estado "${campaign.status}" y no puede iniciarse`);
  }

  if (!campaign.templateSnapshot) {
    return releaseSlot("La campaña no tiene plantilla configurada");
  }

  // Check there are recipients — workspace-scoped
  const [recipientCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.campaignId, campaignId),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
      eq(campaignRecipientsTable.status, opts.retryFailed ? "failed" : "pending"),
    ));

  if ((recipientCount?.count ?? 0) === 0) {
    return releaseSlot(opts.retryFailed ? "No hay envíos fallidos para reintentar" : "La campaña no tiene destinatarios pendientes");
  }

  // If retrying failed, reset their status to pending — workspace-scoped
  if (opts.retryFailed) {
    await db.update(campaignRecipientsTable)
      .set({ status: "pending", error: null, sentAt: null })
      .where(and(
        eq(campaignRecipientsTable.campaignId, campaignId),
        eq(campaignRecipientsTable.workspaceId, workspaceId),
        eq(campaignRecipientsTable.status, "failed"),
      ));
  }

  // Mark campaign as sending — workspace-scoped
  await db.update(marketingCampaignsTable)
    .set({
      status: "sending",
      startedAt: campaign.startedAt ?? new Date(),
      finishedAt: null,
    })
    .where(and(
      eq(marketingCampaignsTable.id, campaignId),
      eq(marketingCampaignsTable.workspaceId, workspaceId),
    ));

  // Create run log
  const [runLog] = await db.insert(campaignRunLogsTable).values({
    workspaceId,
    campaignId,
    segmentId: campaign.segmentId ?? null,
    templateId: campaign.templateId ?? null,
    initiatedBy: opts.initiatedBy ?? null,
  }).returning({ id: campaignRunLogsTable.id });

  // The slot is already reserved in activeQueues — update rateMs from validated value
  reservedEntry.rateMs = Math.max(MIN_RATE_MS, opts.rateMs ?? DEFAULT_RATE_MS);

  // Start processing in background (don't await)
  processQueue(campaignId, workspaceId, runLog.id).catch((e) => {
    logger.error({ err: e, campaignId }, "Campaign queue crashed");
    activeQueues.delete(campaignId);
    db.update(marketingCampaignsTable)
      .set({ status: "with_errors" })
      .where(and(
        eq(marketingCampaignsTable.id, campaignId),
        eq(marketingCampaignsTable.workspaceId, workspaceId),
      ))
      .catch(() => {});
  });

  return { ok: true };
}

/** Pause a running queue. The current message in-flight will finish. */
export async function pauseCampaignQueue(campaignId: number, workspaceId: number): Promise<{ ok: boolean; error?: string }> {
  // Ownership check: reject if the entry belongs to a different workspace
  const entry = activeQueues.get(campaignId);
  if (entry && entry.workspaceId !== workspaceId) {
    return { ok: false, error: "La campaña no está en ejecución" };
  }
  if (!entry || entry.cancelled) return { ok: false, error: "La campaña no está en ejecución" };
  entry.paused = true;
  await db.update(marketingCampaignsTable)
    .set({ status: "paused" })
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  emit(workspaceId, "campaign:progress", { campaignId, paused: true });
  return { ok: true };
}

/** Resume a paused queue. */
export async function resumeCampaignQueue(campaignId: number, workspaceId: number): Promise<{ ok: boolean; error?: string }> {
  const entry = activeQueues.get(campaignId);
  // Ownership check: reject if the entry belongs to a different workspace
  if (entry && entry.workspaceId !== workspaceId) {
    return { ok: false, error: "La campaña no está en ejecución" };
  }
  if (!entry || entry.cancelled) {
    // Queue not in memory — restart it
    return startCampaignQueue(campaignId, workspaceId);
  }
  entry.paused = false;
  await db.update(marketingCampaignsTable)
    .set({ status: "sending" })
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  emit(workspaceId, "campaign:progress", { campaignId, paused: false });
  return { ok: true };
}

/** Cancel a campaign — stops the queue and marks remaining pending as cancelled. */
export async function cancelCampaignQueue(campaignId: number, workspaceId: number): Promise<{ ok: boolean }> {
  const entry = activeQueues.get(campaignId);
  // Ownership check: silently ignore attempts from different workspaces
  if (entry && entry.workspaceId !== workspaceId) {
    // Still update DB with ownership scope — no-op if campaign doesn't belong to this workspace
    await db.update(marketingCampaignsTable)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));
    return { ok: true };
  }
  if (entry) {
    entry.cancelled = true;
    entry.paused = false;
  }
  await db.update(marketingCampaignsTable)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(marketingCampaignsTable.id, campaignId), eq(marketingCampaignsTable.workspaceId, workspaceId)));
  // Leave pending recipients as-is (they were never sent, so no retry needed)
  return { ok: true };
}

/** Get live progress snapshot for a campaign. */
export async function getCampaignProgress(campaignId: number, workspaceId: number) {
  // Use ::int casts so PostgreSQL returns numbers, not strings.
  // Without them, JS string concatenation makes "sent + failed" = "10" instead of 1.
  const [stats] = await db
    .select({
      sent:     sql<number>`count(*) filter (where status = 'sent')::int`,
      failed:   sql<number>`count(*) filter (where status = 'failed')::int`,
      pending:  sql<number>`count(*) filter (where status = 'pending')::int`,
      excluded: sql<number>`count(*) filter (where status = 'excluded')::int`,
      total:    sql<number>`count(*)::int`,
    })
    .from(campaignRecipientsTable)
    .where(and(
      eq(campaignRecipientsTable.campaignId, campaignId),
      eq(campaignRecipientsTable.workspaceId, workspaceId),
    ));

  // Also fetch campaign status from DB so the progress panel can detect completion.
  const [campaign] = await db
    .select({ status: marketingCampaignsTable.status })
    .from(marketingCampaignsTable)
    .where(and(
      eq(marketingCampaignsTable.id, campaignId),
      eq(marketingCampaignsTable.workspaceId, workspaceId),
    ));

  const entry = activeQueues.get(campaignId);
  const rateMs = entry?.rateMs ?? DEFAULT_RATE_MS;
  const pending = stats?.pending ?? 0;

  return {
    campaignId,
    status: campaign?.status ?? "draft",
    sent:     stats?.sent ?? 0,
    failed:   stats?.failed ?? 0,
    pending,
    excluded: stats?.excluded ?? 0,
    total:    stats?.total ?? 0,
    estimatedSecondsLeft: pending > 0 ? Math.ceil((pending * rateMs) / 1000) : 0,
    rateMs,
    paused: entry?.paused ?? false,
    running: isRunning(campaignId),
  };
}

export { DEFAULT_RATE_MS, isRunning };
