/**
 * Calendar ↔ CRM sync service.
 *
 * Provides:
 *  - buildCalendarEventBody    — rich Google Calendar event payload from a task + optional client
 *  - syncTaskToCalendar        — idempotent create-or-patch a Calendar event for a task
 *  - pullCalendarChangesForWorkspace — pull recently-modified events back to CRM tasks (15-min poll)
 */

import { google } from "googleapis";
import { db } from "@workspace/db";
import { tasksTable, clientsTable } from "@workspace/db";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import { getAuthedClient } from "../lib/googleCalendarAuth";
import { frontendUrl } from "../lib/frontendUrl";
import { logger } from "../lib/logger";

// ── Color IDs per event type ──────────────────────────────────────────────────
const CALENDAR_COLORS: Record<string, string> = {
  llamada: "11",      // Tomato
  visita: "2",        // Sage
  seguimiento: "5",   // Banana
  "reunión": "9",     // Blueberry
  entrega: "8",       // Graphite
  "capacitación": "10", // Basil
  "presentación": "7",  // Peacock
};

function colorForType(calendarEventType: string | null | undefined): string | undefined {
  if (!calendarEventType) return undefined;
  return CALENDAR_COLORS[calendarEventType.toLowerCase()] ?? undefined;
}

// ── Timezone-safe formatter ───────────────────────────────────────────────────
/**
 * Format a Date as "YYYY-MM-DDTHH:MM:SS" in the given IANA timezone, WITHOUT
 * any trailing "Z" or UTC offset.
 *
 * CRITICAL: Google Calendar interprets `dateTime` as LOCAL time in `timeZone`
 * when the string has no zone offset. Sending toISOString() (which appends "Z")
 * tells Google the time is UTC and it ignores `timeZone`, causing a 3-hour
 * shift for Argentina (UTC-3). Use this function instead.
 */
function toLocalDateTimeString(date: Date, tz: string): string {
  // sv-SE locale gives ISO-like "YYYY-MM-DD HH:MM:SS" — replace space with T
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date).replace(" ", "T");
}

// ── Event body builder ────────────────────────────────────────────────────────
interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  dueAt: Date | null;
  calendarEventType: string | null;
  clientId: number | null;
  workspaceId: number;
}

interface ClientRow {
  name: string | null;
  company: string | null;
  phone: string | null;
}

export function buildCalendarEventBody(
  task: TaskRow,
  client: ClientRow | null,
) {
  const start = task.dueAt ?? new Date();
  const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour
  const tz = "America/Argentina/Buenos_Aires";

  const lines: string[] = [];
  if (task.description) lines.push(task.description);
  if (client?.name) lines.push(`👤 Cliente: ${client.name}`);
  if (client?.company) lines.push(`🏢 Empresa: ${client.company}`);
  if (client?.phone) lines.push(`📞 Tel: ${client.phone}`);
  const deepLink = frontendUrl("/tasks");
  lines.push(`🔗 Ver en CRM: ${deepLink}`);

  const body: Record<string, unknown> = {
    summary: task.title,
    description: lines.join("\n"),
    start: { dateTime: toLocalDateTimeString(start, tz), timeZone: tz },
    end: { dateTime: toLocalDateTimeString(end, tz), timeZone: tz },
  };

  const colorId = colorForType(task.calendarEventType);
  if (colorId) body.colorId = colorId;

  return body;
}

// ── Sync a single task → Google Calendar ─────────────────────────────────────
export async function syncTaskToCalendar(
  taskId: number,
  workspaceId: number,
): Promise<{ ok: boolean; googleCalendarEventId?: string; error?: string }> {
  try {
    // Fetch task + client in parallel
    const [taskRow] = await db
      .select({
        id: tasksTable.id,
        title: tasksTable.title,
        description: tasksTable.description,
        dueAt: tasksTable.dueAt,
        calendarEventType: tasksTable.calendarEventType,
        clientId: tasksTable.clientId,
        workspaceId: tasksTable.workspaceId,
        googleCalendarEventId: tasksTable.googleCalendarEventId,
      })
      .from(tasksTable)
      .where(and(eq(tasksTable.id, taskId), eq(tasksTable.workspaceId, workspaceId)));

    if (!taskRow) return { ok: false, error: "task_not_found" };
    if (!taskRow.dueAt) return { ok: false, error: "task_has_no_due_date" };

    let client: ClientRow | null = null;
    if (taskRow.clientId) {
      const [cl] = await db
        .select({ name: clientsTable.name, company: clientsTable.company, phone: clientsTable.phone })
        .from(clientsTable)
        .where(and(eq(clientsTable.id, taskRow.clientId), eq(clientsTable.workspaceId, workspaceId)));
      client = cl ?? null;
    }

    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });
    const body = buildCalendarEventBody(taskRow, client);

    // Timezone audit log — helps diagnose any future time shifts
    logger.info({
      taskId,
      taskTitle: taskRow.title,
      dueAtUTC: taskRow.dueAt!.toISOString(),
      dateTimeSent: (body.start as any).dateTime,
      timeZone: (body.start as any).timeZone,
    }, "[Calendar] Sending event to Google — timezone audit");

    let googleCalendarEventId: string;

    if (taskRow.googleCalendarEventId) {
      // Idempotent patch — update existing event
      const { data } = await calendar.events.patch({
        calendarId: "primary",
        eventId: taskRow.googleCalendarEventId,
        requestBody: body,
      });
      googleCalendarEventId = data.id!;
      logger.info({ taskId, googleEventId: googleCalendarEventId, googleStart: (data.start as any)?.dateTime }, "[Calendar] Patch confirmed");
    } else {
      // Create new event
      const { data } = await calendar.events.insert({
        calendarId: "primary",
        requestBody: body,
      });
      googleCalendarEventId = data.id!;
      logger.info({ taskId, googleEventId: googleCalendarEventId, googleStart: (data.start as any)?.dateTime }, "[Calendar] Insert confirmed");

      // Store the event ID back on the task
      await db
        .update(tasksTable)
        .set({ googleCalendarEventId })
        .where(and(eq(tasksTable.id, taskId), eq(tasksTable.workspaceId, workspaceId)));
    }

    return { ok: true, googleCalendarEventId };
  } catch (err: any) {
    logger.error({ err, taskId, workspaceId }, "calendarSync.syncTaskToCalendar failed");
    return { ok: false, error: err.message ?? "sync_failed" };
  }
}

// ── Patch only the time of an existing calendar event (used by PATCH /tasks) ─
export async function patchCalendarEventTime(
  workspaceId: number,
  googleCalendarEventId: string,
  dueAt: Date,
): Promise<void> {
  try {
    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });
    const tz = "America/Argentina/Buenos_Aires";
    const end = new Date(dueAt.getTime() + 60 * 60 * 1000);
    await calendar.events.patch({
      calendarId: "primary",
      eventId: googleCalendarEventId,
      requestBody: {
        start: { dateTime: toLocalDateTimeString(dueAt, tz), timeZone: tz },
        end: { dateTime: toLocalDateTimeString(end, tz), timeZone: tz },
      },
    });
  } catch (err: any) {
    // Non-blocking — log and swallow
    logger.warn({ err, workspaceId, googleCalendarEventId }, "calendarSync.patchCalendarEventTime failed (non-fatal)");
  }
}

// ── Pull recently-modified Google Calendar events back into tasks ─────────────
export async function pullCalendarChangesForWorkspace(workspaceId: number): Promise<void> {
  try {
    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });

    // Look at events modified in the last 20 minutes (15-min poll + 5-min buffer)
    const updatedMin = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    const { data } = await calendar.events.list({
      calendarId: "primary",
      updatedMin,
      singleEvents: true,
      maxResults: 50,
    });

    const events = data.items ?? [];
    if (!events.length) return;

    const eventIds = events.map(e => e.id!).filter(Boolean);

    // Find CRM tasks that are linked to these Google Calendar events
    const linkedTasks = await db
      .select({
        id: tasksTable.id,
        dueAt: tasksTable.dueAt,
        googleCalendarEventId: tasksTable.googleCalendarEventId,
      })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.workspaceId, workspaceId),
          isNotNull(tasksTable.googleCalendarEventId),
          inArray(tasksTable.googleCalendarEventId as any, eventIds),
        ),
      );

    for (const task of linkedTasks) {
      const event = events.find(e => e.id === task.googleCalendarEventId);
      if (!event) continue;

      // Extract start time from the event
      const startRaw = event.start?.dateTime ?? event.start?.date;
      if (!startRaw) continue;
      const newDueAt = new Date(startRaw);
      if (isNaN(newDueAt.getTime())) continue;

      // Only update if the date actually changed (>1 min difference to avoid noise)
      const currentMs = task.dueAt?.getTime() ?? 0;
      if (Math.abs(newDueAt.getTime() - currentMs) < 60_000) continue;

      await db
        .update(tasksTable)
        .set({ dueAt: newDueAt })
        .where(and(eq(tasksTable.id, task.id), eq(tasksTable.workspaceId, workspaceId)));

      logger.info(
        { taskId: task.id, workspaceId, newDueAt },
        "calendarSync: updated task dueAt from Google Calendar change",
      );
    }
  } catch (err: any) {
    // not_connected / credentials_not_configured are expected for workspaces
    // that haven't set up Google Calendar — swallow silently.
    if (err.message !== "not_connected" && err.message !== "credentials_not_configured") {
      logger.warn({ err, workspaceId }, "pullCalendarChangesForWorkspace failed");
    }
  }
}
