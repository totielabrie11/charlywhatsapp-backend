/**
 * Calendar Sync Scheduler
 *
 * Polls every 15 minutes to pull recently-modified Google Calendar events
 * back into CRM tasks. Runs per workspace (any workspace that has a
 * connected Google Calendar token).
 */

import { db } from "@workspace/db";
import { googleCalendarTokensTable } from "@workspace/db";
import { pullCalendarChangesForWorkspace } from "./calendarSync";
import { logger } from "../lib/logger";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let _timer: ReturnType<typeof setInterval> | null = null;

async function pullAllWorkspaces() {
  try {
    const tokens = await db
      .select({ workspaceId: googleCalendarTokensTable.workspaceId })
      .from(googleCalendarTokensTable);

    for (const { workspaceId } of tokens) {
      await pullCalendarChangesForWorkspace(workspaceId);
    }
  } catch (err) {
    logger.error({ err }, "calendarSyncService: error pulling calendar changes");
  }
}

export function startCalendarSyncService() {
  if (_timer) return;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Calendar sync service started");
  _timer = setInterval(() => void pullAllWorkspaces(), POLL_INTERVAL_MS);
}

export function stopCalendarSyncService() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info("Calendar sync service stopped");
  }
}
