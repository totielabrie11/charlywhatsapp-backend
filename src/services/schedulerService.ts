/**
 * Campaign Scheduler Service
 *
 * Polls the DB every 30 seconds for campaigns with status = 'scheduled'
 * whose scheduledAt <= now(). Fires them using the existing campaignQueue
 * send infrastructure — no direct WhatsApp calls here.
 */

import { db } from "@workspace/db";
import { marketingCampaignsTable, campaignEventsTable } from "@workspace/db";
import { eq, and, lte, sql } from "drizzle-orm";
import { startCampaignQueue } from "./campaignQueue";
import { logger } from "../lib/logger";

const POLL_INTERVAL_MS = 30_000;
let _timer: ReturnType<typeof setInterval> | null = null;

/** Insert a campaign event row (fire-and-forget, errors are logged). */
async function writeCampaignEvent(
  campaignId: number,
  workspaceId: number,
  eventType: string,
  description: string,
  actor: string = "scheduler",
) {
  try {
    await db.insert(campaignEventsTable).values({
      campaignId,
      workspaceId,
      eventType,
      description,
      actor,
    });
  } catch (e) {
    logger.warn({ err: e, campaignId, eventType }, "schedulerService: failed to write event");
  }
}

async function fireScheduledCampaigns() {
  try {
    const now = new Date();

    // Find all campaigns that are overdue for firing
    const due = await db
      .select({
        id: marketingCampaignsTable.id,
        workspaceId: marketingCampaignsTable.workspaceId,
        name: marketingCampaignsTable.name,
        scheduledAt: marketingCampaignsTable.scheduledAt,
      })
      .from(marketingCampaignsTable)
      .where(
        and(
          eq(marketingCampaignsTable.status, "scheduled"),
          lte(marketingCampaignsTable.scheduledAt, now),
        ),
      );

    for (const campaign of due) {
      logger.info({ campaignId: campaign.id, workspaceId: campaign.workspaceId }, "scheduler: firing scheduled campaign");

      // startCampaignQueue will atomically transition status from "scheduled" → "sending"
      // and reject duplicate starts via the activeQueues idempotency guard.
      const result = await startCampaignQueue(campaign.id, campaign.workspaceId, {
        initiatedBy: "scheduler",
      });

      if (!result.ok) {
        logger.error({ campaignId: campaign.id, error: result.error }, "scheduler: failed to start queue");
        await writeCampaignEvent(
          campaign.id,
          campaign.workspaceId,
          "error",
          `Error al iniciar el envío: ${result.error}`,
          "scheduler",
        );
        // Campaign remains in "scheduled" — next poll will retry automatically.
      } else {
        await writeCampaignEvent(
          campaign.id,
          campaign.workspaceId,
          "send_started",
          `Envío iniciado automáticamente (programado para ${campaign.scheduledAt?.toISOString() ?? "ahora"})`,
          "scheduler",
        );
      }
    }
  } catch (e) {
    logger.error({ err: e }, "schedulerService: error in fireScheduledCampaigns");
  }
}

export function startScheduler() {
  if (_timer) return; // already running
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Campaign scheduler started");
  // Fire once immediately, then on interval
  void fireScheduledCampaigns();
  _timer = setInterval(() => void fireScheduledCampaigns(), POLL_INTERVAL_MS);
}

export function stopScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info("Campaign scheduler stopped");
  }
}

/** Exported so routes can write events without importing the full service. */
export { writeCampaignEvent };
