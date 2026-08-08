/**
 * Task Reminder Scheduler
 *
 * Polls every 5 minutes for tasks whose `dueAt` is 25–35 minutes away
 * AND that have a `googleCalendarEventId` (i.e. they are calendar-linked).
 * Fires a `task:reminder` Socket.io event to the workspace room once per
 * task-occurrence. Deduplication is in-memory (keys survive process lifetime).
 */

import { db } from "@workspace/db";
import { tasksTable, clientsTable } from "@workspace/db";
import { eq, and, isNotNull, gte, lte, inArray, ne } from "drizzle-orm";
import { emit as socketEmit } from "../lib/socket";
import { logger } from "../lib/logger";

const POLL_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 min
const WINDOW_BEFORE_MS = 25 * 60 * 1000;  // start of 30-min window
const WINDOW_AFTER_MS  = 35 * 60 * 1000;  // end of window (grace ±5 min)

// key = `taskId:YYYY-MM-DD` — day-level so a restart within the same day doesn't re-fire
const firedReminders = new Set<string>();

let _timer: ReturnType<typeof setInterval> | null = null;

async function fireUpcomingReminders() {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() + WINDOW_BEFORE_MS);
    const windowEnd   = new Date(now.getTime() + WINDOW_AFTER_MS);

    const tasks = await db
      .select({
        id: tasksTable.id,
        title: tasksTable.title,
        dueAt: tasksTable.dueAt,
        calendarEventType: tasksTable.calendarEventType,
        clientId: tasksTable.clientId,
        workspaceId: tasksTable.workspaceId,
        googleCalendarEventId: tasksTable.googleCalendarEventId,
      })
      .from(tasksTable)
      .where(
        and(
          isNotNull(tasksTable.googleCalendarEventId),
          isNotNull(tasksTable.dueAt),
          gte(tasksTable.dueAt, windowStart),
          lte(tasksTable.dueAt, windowEnd),
          inArray(tasksTable.status, ["pending", "in_progress", "scheduled"]),
        ),
      );

    for (const task of tasks) {
      const dayKey = task.dueAt!.toISOString().substring(0, 10);
      const fireKey = `${task.id}:${dayKey}`;
      if (firedReminders.has(fireKey)) continue;
      firedReminders.add(fireKey);

      // Fetch client info + open task list for that client
      let clientName: string | null = null;
      let clientCompany: string | null = null;
      let clientId: number | null = task.clientId;
      const openTaskTitles: string[] = [];

      if (task.clientId) {
        const [cl] = await db
          .select({ name: clientsTable.name, company: clientsTable.company })
          .from(clientsTable)
          .where(eq(clientsTable.id, task.clientId));
        clientName = cl?.name ?? null;
        clientCompany = cl?.company ?? null;

        // Fetch open tasks for this client (excluding the current reminder task)
        const openTasks = await db
          .select({ title: tasksTable.title })
          .from(tasksTable)
          .where(
            and(
              eq(tasksTable.clientId, task.clientId),
              eq(tasksTable.workspaceId, task.workspaceId),
              inArray(tasksTable.status, ["pending", "in_progress"]),
              ne(tasksTable.id, task.id),
            ),
          )
          .limit(5);
        openTaskTitles.push(...openTasks.map(t => t.title));
      }

      socketEmit(task.workspaceId, "task:reminder", {
        taskId: task.id,
        title: task.title,
        dueAt: task.dueAt!.toISOString(),
        calendarEventType: task.calendarEventType,
        clientId,
        clientName,
        clientCompany,
        openTaskTitles,
      });

      logger.info(
        { taskId: task.id, workspaceId: task.workspaceId, dueAt: task.dueAt },
        "reminderService: fired task:reminder",
      );
    }
  } catch (err) {
    logger.error({ err }, "reminderService: error in fireUpcomingReminders");
  }
}

export function startReminderService() {
  if (_timer) return;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Task reminder service started");
  // Fire once immediately (covers the case where server restarts near a reminder window)
  void fireUpcomingReminders();
  _timer = setInterval(() => void fireUpcomingReminders(), POLL_INTERVAL_MS);
}

export function stopReminderService() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info("Task reminder service stopped");
  }
}
