import { Router } from "express";
import { google } from "googleapis";
import { db } from "@workspace/db";
import { googleCalendarTokensTable, googleCalendarSettingsTable, tasksTable } from "@workspace/db";
import { eq, and, gte, lte, isNotNull, isNull } from "drizzle-orm";
import {
  getOAuthCredentials,
  makeOAuth2Client,
  getAuthedClient,
} from "../lib/googleCalendarAuth";
import { frontendUrl } from "../lib/frontendUrl";
import { syncTaskToCalendar, pullCalendarChangesForWorkspace } from "../services/calendarSync";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ── Public router — OAuth callback (no Clerk/workspace auth required) ─────────
// Registered BEFORE requireWorkspace in routes/index.ts.
export const calendarPublicRouter = Router();

calendarPublicRouter.get("/calendar/auth/callback", async (req, res) => {
  const { code, state, error } = req.query as {
    code?: string;
    state?: string;
    error?: string;
  };

  if (error) {
    res.redirect(frontendUrl(`/calendar?error=${encodeURIComponent(error)}`));
    return;
  }
  if (!code || !state) {
    res.redirect(frontendUrl("/calendar?error=missing_params"));
    return;
  }

  let workspaceId: number;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf-8");
    workspaceId = parseInt(decoded.split(":")[0]);
    if (isNaN(workspaceId)) throw new Error("bad");
  } catch {
    res.redirect(frontendUrl("/calendar?error=invalid_state"));
    return;
  }

  try {
    const oauth2Client = await makeOAuth2Client(workspaceId);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error("[Calendar OAuth] Missing tokens in response:", {
        hasAccess: !!tokens.access_token,
        hasRefresh: !!tokens.refresh_token,
      });
      res.redirect(frontendUrl("/calendar?error=incomplete_tokens"));
      return;
    }

    // Fetch the Google account email for display purposes (non-fatal).
    let userEmail: string | null = null;
    try {
      const oauth2Api = google.oauth2({ version: "v2", auth: oauth2Client });
      const { data: userInfo } = await oauth2Api.userinfo.get();
      userEmail = userInfo.email ?? null;
    } catch (emailErr: any) {
      console.warn("[Calendar OAuth] Could not fetch user email (non-fatal):", emailErr.message);
    }

    await db
      .insert(googleCalendarTokensTable)
      .values({
        workspaceId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        email: userEmail,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: googleCalendarTokensTable.workspaceId,
        set: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          email: userEmail,
          updatedAt: new Date(),
        },
      });

    res.redirect(frontendUrl("/calendar?connected=1"));
  } catch (err: any) {
    console.error("[Calendar OAuth] callback error:", err?.response?.data ?? err.message);
    res.redirect(frontendUrl(`/calendar?error=${encodeURIComponent(err.message ?? "token_exchange_failed")}`));
  }
});

// ── Private router (requires workspace auth via requireWorkspace middleware) ───
const router = Router();
export default router;

// ─── GET /calendar/credentials ────────────────────────────────────────────────
router.get("/calendar/credentials", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const [row] = await db
    .select({ clientId: googleCalendarSettingsTable.clientId })
    .from(googleCalendarSettingsTable)
    .where(eq(googleCalendarSettingsTable.workspaceId, workspaceId));

  if (row) {
    res.json({ configured: true, source: "database", clientId: row.clientId });
  } else if (process.env.GOOGLE_CLIENT_ID) {
    res.json({ configured: true, source: "env", clientId: process.env.GOOGLE_CLIENT_ID });
  } else {
    res.json({ configured: false, source: null, clientId: null });
  }
});

// ─── POST /calendar/credentials ───────────────────────────────────────────────
router.post("/calendar/credentials", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { clientId, clientSecret } = req.body as { clientId?: string; clientSecret?: string };

  if (!clientId?.trim() || !clientSecret?.trim()) {
    res.status(400).json({ error: "clientId y clientSecret son requeridos" });
    return;
  }

  await db
    .insert(googleCalendarSettingsTable)
    .values({
      workspaceId,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: googleCalendarSettingsTable.workspaceId,
      set: {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        updatedAt: new Date(),
      },
    });

  res.json({ ok: true });
});

// ─── DELETE /calendar/credentials ─────────────────────────────────────────────
router.delete("/calendar/credentials", async (req, res) => {
  const workspaceId = req.workspaceId!;
  await db
    .delete(googleCalendarSettingsTable)
    .where(eq(googleCalendarSettingsTable.workspaceId, workspaceId));
  res.json({ ok: true });
});

// ─── GET /calendar/status ─────────────────────────────────────────────────────
router.get("/calendar/status", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const [token] = await db
    .select({ email: googleCalendarTokensTable.email, updatedAt: googleCalendarTokensTable.updatedAt })
    .from(googleCalendarTokensTable)
    .where(eq(googleCalendarTokensTable.workspaceId, workspaceId));

  const creds = await getOAuthCredentials(workspaceId);

  res.json({
    connected: !!token,
    email: token?.email ?? null,
    connectedAt: token?.updatedAt ?? null,
    credentialsConfigured: !!creds,
  });
});

// ─── GET /calendar/auth — initiate OAuth flow ─────────────────────────────────
router.get("/calendar/auth", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const state = Buffer.from(`${workspaceId}:${Date.now()}`).toString("base64url");
    const oauth2Client = await makeOAuth2Client(workspaceId);
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
      state,
    });
    res.json({ url });
  } catch (err: any) {
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── DELETE /calendar/auth — disconnect ──────────────────────────────────────
router.delete("/calendar/auth", async (req, res) => {
  const workspaceId = req.workspaceId!;
  await db
    .delete(googleCalendarTokensTable)
    .where(eq(googleCalendarTokensTable.workspaceId, workspaceId));
  res.json({ ok: true });
});

// ─── GET /calendar/availability ───────────────────────────────────────────────
// Returns whether the requested slot is free, any conflicting events, and up
// to 3 free-slot suggestions strictly AFTER the conflict.
//
// Busy intervals are built from TWO sources:
//   1. Google Calendar events for that day
//   2. CRM tasks saved in the DB for that day (prevents race conditions when
//      two events are scheduled within seconds of each other and the second
//      check runs before the first is synced to Google Calendar)
//
// Suggestions only go FORWARD from the end of the latest conflict — never
// backwards — so two clients scheduled at the same time will always land on
// different, consecutive slots.
router.get("/calendar/availability", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { date, startTime, endTime } = req.query as {
    date?: string; startTime?: string; endTime?: string;
  };

  if (!date || !startTime || !endTime) {
    res.status(400).json({ error: "date, startTime, endTime are required" });
    return;
  }

  try {
    const THIRTY_MIN_MS = 30 * 60 * 1000;

    // ── Helpers ────────────────────────────────────────────────────────────
    const fmtTime = (ms: number): string => {
      const p = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(ms));
      return `${p.find(x => x.type === "hour")!.value}:${p.find(x => x.type === "minute")!.value}`;
    };
    const argHour = (ms: number): number =>
      parseInt(new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour: "2-digit", hour12: false,
      }).formatToParts(new Date(ms)).find(x => x.type === "hour")!.value);

    // ── Slot boundaries (UTC ms) ───────────────────────────────────────────
    const slotStartMs = new Date(`${date}T${startTime}:00-03:00`).getTime();
    const slotEndMs   = new Date(`${date}T${endTime}:00-03:00`).getTime();
    const durationMs  = slotEndMs - slotStartMs;

    // ── Source 1: Google Calendar events for that day ──────────────────────
    type BusyInterval = { startMs: number; endMs: number; summary: string };
    const busyIntervals: BusyInterval[] = [];

    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });

    const { data } = await calendar.events.list({
      calendarId: "primary",
      timeMin: `${date}T00:00:00-03:00`,
      timeMax: `${date}T23:59:59-03:00`,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
    });
    const seenIds = new Set<string>();
    for (const ev of data.items ?? []) {
      if (!ev.id || seenIds.has(ev.id) || !ev.start?.dateTime) continue;
      seenIds.add(ev.id);
      busyIntervals.push({
        startMs: new Date(ev.start.dateTime).getTime(),
        endMs:   new Date(ev.end?.dateTime ?? ev.start.dateTime).getTime(),
        summary: ev.summary ?? "Evento sin título",
      });
    }

    // ── Source 2: CRM tasks with dueAt on the same day ────────────────────
    // This prevents race conditions: a task saved moments ago may not yet
    // appear in Google Calendar but IS already in the DB.
    const dayStartUTC = new Date(`${date}T00:00:00-03:00`);
    const dayEndUTC   = new Date(`${date}T23:59:59-03:00`);
    // Only include tasks that have NOT yet been synced to Google Calendar
    // (googleCalendarEventId IS NULL). Tasks that already have a Google event
    // are represented by the Google Calendar fetch above — if that event was
    // later deleted from Google Calendar the task will have googleCalendarEventId
    // set but won't appear in the Google list, so excluding those tasks here
    // prevents phantom conflicts from deleted events.
    const crmTasks = await db
      .select({ title: tasksTable.title, dueAt: tasksTable.dueAt })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.workspaceId, workspaceId),
          isNotNull(tasksTable.dueAt),
          gte(tasksTable.dueAt, dayStartUTC),
          lte(tasksTable.dueAt, dayEndUTC),
          isNotNull(tasksTable.calendarEventType),
          isNull(tasksTable.googleCalendarEventId),
        ),
      );
    for (const task of crmTasks) {
      if (!task.dueAt) continue;
      const ts = task.dueAt.getTime();
      const te = ts + THIRTY_MIN_MS; // tasks default to 30 min
      busyIntervals.push({ startMs: ts, endMs: te, summary: task.title ?? "Tarea CRM" });
    }

    // ── Detect conflicts in the requested slot ─────────────────────────────
    const conflicting = busyIntervals.filter(
      b => b.startMs < slotEndMs && b.endMs > slotStartMs,
    );
    const conflicts = conflicting.map(b => ({
      summary: b.summary,
      start: new Date(b.startMs).toISOString(),
      end:   new Date(b.endMs).toISOString(),
      durationMin: Math.round((b.endMs - b.startMs) / 60000),
    }));
    const available = conflicts.length === 0;

    // ── Build suggestions: strictly forward from the latest conflict end ───
    // Start scanning from the END of the latest overlapping event, snapped
    // forward to the nearest 30-min grid boundary.
    const suggestions: { start: string; end: string }[] = [];
    if (!available) {
      const latestConflictEndMs = Math.max(...conflicting.map(b => b.endMs));
      // Snap forward to next 30-min boundary
      const scanFrom = Math.ceil(latestConflictEndMs / THIRTY_MIN_MS) * THIRTY_MIN_MS;

      for (let i = 0; suggestions.length < 3 && i < 32; i++) {
        const cs = scanFrom + i * THIRTY_MIN_MS;
        const ce = cs + durationMs;
        // Don't suggest slots more than 24h in the future
        if (cs > slotStartMs + 24 * 60 * 60 * 1000) break;
        // Don't suggest past slots (>10 min ago)
        if (cs < Date.now() - 10 * 60000) continue;
        const hasConflict = busyIntervals.some(b => b.startMs < ce && b.endMs > cs);
        if (!hasConflict) {
          suggestions.push({ start: fmtTime(cs), end: fmtTime(ce) });
        }
      }
    }

    res.json({ available, conflicts, suggestions });
  } catch (err: any) {
    const status = err.statusCode ?? (err.message === "not_connected" ? 401 : 502);
    res.status(status).json({ error: err.message });
  }
});

// ─── GET /calendar/events ─────────────────────────────────────────────────────
router.get("/calendar/events", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { start, end, q } = req.query as {
    start?: string;
    end?: string;
    q?: string;
  };

  try {
    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });

    const { data } = await calendar.events.list({
      calendarId: "primary",
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 1000,
      q: q || undefined,
    });

    res.json(data.items ?? []);
  } catch (err: any) {
    const status = err.statusCode ?? (err.message === "not_connected" ? 401 : 502);
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /calendar/events ────────────────────────────────────────────────────
router.post("/calendar/events", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });
    const { data } = await calendar.events.insert({
      calendarId: "primary",
      requestBody: req.body,
    });
    res.status(201).json(data);
  } catch (err: any) {
    const status = err.statusCode ?? 502;
    res.status(status).json({ error: err.message });
  }
});

// ─── PATCH /calendar/events/:id ───────────────────────────────────────────────
router.patch("/calendar/events/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { id } = req.params;
  try {
    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });
    const { data } = await calendar.events.patch({
      calendarId: "primary",
      eventId: id,
      requestBody: req.body,
    });
    res.json(data);
  } catch (err: any) {
    const status = err.statusCode ?? 502;
    res.status(status).json({ error: err.message });
  }
});

// ─── DELETE /calendar/events/:id ──────────────────────────────────────────────
router.delete("/calendar/events/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { id } = req.params;
  try {
    const auth = await getAuthedClient(workspaceId);
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.delete({ calendarId: "primary", eventId: id });
    res.status(204).end();
  } catch (err: any) {
    const status = err.statusCode ?? 502;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /calendar/tasks/:taskId/sync ────────────────────────────────────────
// Idempotent: creates a new Calendar event for this task, or patches the
// existing one if googleCalendarEventId is already set. Stores the event ID
// back on the task row.
router.post("/calendar/tasks/:taskId/sync", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const taskId = parseInt(req.params.taskId);
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid taskId" });
    return;
  }

  const result = await syncTaskToCalendar(taskId, workspaceId);
  if (!result.ok) {
    const status =
      result.error === "task_not_found" ? 404
      : result.error === "task_has_no_due_date" ? 422
      : result.error === "not_connected" ? 401
      : 502;
    res.status(status).json({ error: result.error });
    return;
  }

  res.json({ ok: true, googleCalendarEventId: result.googleCalendarEventId });
});

// ─── POST /calendar/pull-changes ──────────────────────────────────────────────
// Manually trigger a pull of recently-modified Calendar events back to tasks.
// Also called automatically by calendarSyncService every 15 minutes.
router.post("/calendar/pull-changes", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    await pullCalendarChangesForWorkspace(workspaceId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /calendar/hints/today — AI-generated prep hints for today's events ───
router.get("/calendar/hints/today", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const today = new Date().toISOString().substring(0, 10);

  const { calendarEventHintsTable, tasksTable, clientsTable } = await import("@workspace/db");
  const { eq: eq2, and: and2 } = await import("drizzle-orm");

  const rows = await db
    .select({
      id: calendarEventHintsTable.id,
      taskId: calendarEventHintsTable.taskId,
      hints: calendarEventHintsTable.hints,
      calendarEventId: calendarEventHintsTable.calendarEventId,
      taskTitle: tasksTable.title,
      dueAt: tasksTable.dueAt,
      calendarEventType: tasksTable.calendarEventType,
      clientId: tasksTable.clientId,
      clientName: clientsTable.name,
      clientCompany: clientsTable.company,
    })
    .from(calendarEventHintsTable)
    .leftJoin(tasksTable, eq2(calendarEventHintsTable.taskId, tasksTable.id))
    .leftJoin(clientsTable, eq2(tasksTable.clientId, clientsTable.id))
    .where(and2(
      eq2(calendarEventHintsTable.workspaceId, workspaceId),
      eq2(calendarEventHintsTable.generatedAt, today),
    ))
    .orderBy(tasksTable.dueAt);

  res.json(rows.map(r => ({
    ...r,
    hints: (() => { try { return JSON.parse(r.hints); } catch { return []; } })(),
    dueAt: r.dueAt?.toISOString() ?? null,
  })));
});

// ─── POST /calendar/hints/generate — force-regenerate today's hints ───────────
router.post("/calendar/hints/generate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const { regenerateTodayHints } = await import("../services/hintService");
    const processed = await regenerateTodayHints(workspaceId);
    res.json({ ok: true, processed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
