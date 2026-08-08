/**
 * Daily Hint Generation Service
 *
 * Once per day (checked hourly), scans every workspace for tasks whose
 * `dueAt` is today AND that have a `googleCalendarEventId`. For each, calls
 * the AI with factual CRM data (client profile, tags, products, recent
 * conversation summary) and stores 2-4 preparation hints in
 * `calendar_event_hints`. Hints are NEVER invented — the prompt explicitly
 * enumerates only what's actually in the database.
 */

import { db } from "@workspace/db";
import {
  tasksTable, clientsTable, calendarEventHintsTable, conversationsTable, workspacesTable,
} from "@workspace/db";
import { eq, and, isNotNull, gte, lte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getAIClient, getAIModel, isAIReady, logAIBlocked } from "./aiProvider";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check once per hour
let _timer: ReturnType<typeof setInterval> | null = null;
let _lastRunDate: string | null = null;   // YYYY-MM-DD

/** Returns the active AI client (delegates to AI Provider Manager). */
function getGroq(workspaceId?: number) {
  return getAIClient(workspaceId);
}

// ── Generate hints for a single task ─────────────────────────────────────────
async function generateHintsForTask(
  task: {
    id: number;
    title: string;
    description: string | null;
    calendarEventType: string | null;
    clientId: number | null;
    workspaceId: number;
    googleCalendarEventId: string;
    dueAt: Date;
  },
  today: string,
): Promise<void> {
  // Already generated today?
  const [existing] = await db
    .select({ id: calendarEventHintsTable.id })
    .from(calendarEventHintsTable)
    .where(and(
      eq(calendarEventHintsTable.taskId, task.id),
      eq(calendarEventHintsTable.generatedAt, today),
    ))
    .limit(1);
  if (existing) return;

  // Gather factual CRM data for the client
  let clientFacts = "";
  if (task.clientId) {
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, task.clientId));

    if (client) {
      const [lastConv] = await db
        .select({ aiSummary: conversationsTable.aiSummary, lastMessage: conversationsTable.lastMessage })
        .from(conversationsTable)
        .where(and(
          eq(conversationsTable.clientId, task.clientId),
          eq(conversationsTable.workspaceId, task.workspaceId),
        ))
        .orderBy(conversationsTable.lastMessageAt)
        .limit(1);

      const facts: string[] = [
        `Cliente: ${client.name}${client.company ? ` (${client.company})` : ""}`,
        `Etapa CRM: ${client.stage ?? "prospect"} | Prioridad: ${client.priority ?? "B"}`,
      ];
      if (client.tags?.length) facts.push(`Etiquetas: ${client.tags.join(", ")}`);
      if ((client as any).consultedProducts?.length)
        facts.push(`Productos consultados: ${((client as any).consultedProducts as string[]).join(", ")}`);
      if ((client as any).purchasedProducts?.length)
        facts.push(`Productos comprados: ${((client as any).purchasedProducts as string[]).join(", ")}`);
      if (client.notes) facts.push(`Notas: ${client.notes.substring(0, 200)}`);
      if (lastConv?.aiSummary) facts.push(`Último resumen de conversación: ${lastConv.aiSummary.substring(0, 300)}`);
      else if (lastConv?.lastMessage) facts.push(`Último mensaje: ${lastConv.lastMessage.substring(0, 200)}`);

      clientFacts = facts.join("\n");
    }
  }

  const eventTypeLabel = task.calendarEventType ?? "evento";
  const timeStr = task.dueAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  const prompt = `Sos un asistente comercial. Tenés que generar de 2 a 4 sugerencias de preparación CONCRETAS para el siguiente evento de hoy.

EVENTO: ${task.title} (${eventTypeLabel}) — ${timeStr}
${task.description ? `Descripción: ${task.description}\n` : ""}
DATOS REALES DEL CLIENTE EN EL CRM:
${clientFacts || "(Sin datos de cliente asociado)"}

INSTRUCCIONES:
- Generá SOLO sugerencias basadas en los datos de CRM mostrados arriba.
- NO inventes datos, productos, precios ni compromisos que no aparezcan arriba.
- Si no hay datos suficientes, generá sugerencias genéricas de preparación comercial.
- Cada sugerencia debe ser una acción concreta (verbo + objeto), máximo 12 palabras.
- Respondé ÚNICAMENTE con un JSON array de strings. Ejemplo: ["Llevar cotización de motores IE3","Consultar stock de variadores G120","Confirmar horario con el cliente"]
- Sin texto adicional, solo el JSON array.`;

  // BYO AI gate — hints require a verified provider; silently skip if not ready
  const { ready: hintReady, reason: hintReason } = isAIReady(task.workspaceId);
  if (!hintReady) {
    logAIBlocked("generateHintsForTask", hintReason ?? "no reason", task.workspaceId);
    return;
  }

  try {
    const completion = await getGroq(task.workspaceId).chat.completions.create({
      model: getAIModel(task.workspaceId),
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.3,
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "[]";
    // Extract JSON array from the response
    const match = raw.match(/\[[\s\S]*\]/);
    const hintsJson = match ? match[0] : "[]";

    // Validate it's a real array
    let hints: string[] = [];
    try {
      hints = JSON.parse(hintsJson);
      if (!Array.isArray(hints)) hints = [];
      hints = hints.filter((h): h is string => typeof h === "string").slice(0, 4);
    } catch { hints = []; }

    if (hints.length === 0) return;

    await db.insert(calendarEventHintsTable).values({
      workspaceId: task.workspaceId,
      taskId: task.id,
      calendarEventId: task.googleCalendarEventId,
      hints: JSON.stringify(hints),
      generatedAt: today,
    }).onConflictDoNothing();

    logger.info({ taskId: task.id, hints: hints.length }, "[HintService] Generated hints");
  } catch (e) {
    logger.warn({ err: e, taskId: task.id }, "[HintService] Failed to generate hints for task");
  }
}

// ── Daily run: find today's calendar-linked tasks across all workspaces ───────
async function runDailyHints() {
  const today = new Date().toISOString().substring(0, 10);
  if (_lastRunDate === today) return; // already ran today
  _lastRunDate = today;

  logger.info({ date: today }, "[HintService] Running daily hint generation");

  try {
    // Find all tasks due today with a Google Calendar event ID
    const dayStart = new Date(`${today}T00:00:00`);
    const dayEnd   = new Date(`${today}T23:59:59`);

    const tasks = await db
      .select({
        id: tasksTable.id,
        title: tasksTable.title,
        description: tasksTable.description,
        calendarEventType: tasksTable.calendarEventType,
        clientId: tasksTable.clientId,
        workspaceId: tasksTable.workspaceId,
        googleCalendarEventId: tasksTable.googleCalendarEventId,
        dueAt: tasksTable.dueAt,
      })
      .from(tasksTable)
      .where(and(
        isNotNull(tasksTable.googleCalendarEventId),
        isNotNull(tasksTable.dueAt),
        gte(tasksTable.dueAt, dayStart),
        lte(tasksTable.dueAt, dayEnd),
      ));

    logger.info({ count: tasks.length, date: today }, "[HintService] Tasks to process");

    for (const task of tasks) {
      if (!task.googleCalendarEventId || !task.dueAt) continue;
      await generateHintsForTask(task as any, today).catch(e =>
        logger.warn({ err: e, taskId: task.id }, "[HintService] Task hint error")
      );
    }
  } catch (e) {
    logger.error({ err: e }, "[HintService] Daily run failed");
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startHintService() {
  // Run immediately on startup (catches today if not yet run)
  void runDailyHints();
  _timer = setInterval(() => { void runDailyHints(); }, CHECK_INTERVAL_MS);
  logger.info("[HintService] Started");
}

export function stopHintService() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  logger.info("[HintService] Stopped");
}

/** Force regeneration for today (called from the API on demand). */
export async function regenerateTodayHints(workspaceId: number): Promise<number> {
  const today = new Date().toISOString().substring(0, 10);

  // Delete existing hints for today in this workspace so they regenerate
  await db.delete(calendarEventHintsTable)
    .where(and(
      eq(calendarEventHintsTable.workspaceId, workspaceId),
      eq(calendarEventHintsTable.generatedAt, today),
    ));

  const dayStart = new Date(`${today}T00:00:00`);
  const dayEnd   = new Date(`${today}T23:59:59`);

  const tasks = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      description: tasksTable.description,
      calendarEventType: tasksTable.calendarEventType,
      clientId: tasksTable.clientId,
      workspaceId: tasksTable.workspaceId,
      googleCalendarEventId: tasksTable.googleCalendarEventId,
      dueAt: tasksTable.dueAt,
    })
    .from(tasksTable)
    .where(and(
      isNotNull(tasksTable.googleCalendarEventId),
      isNotNull(tasksTable.dueAt),
      gte(tasksTable.dueAt, dayStart),
      lte(tasksTable.dueAt, dayEnd),
      eq(tasksTable.workspaceId, workspaceId),
    ));

  for (const task of tasks) {
    if (!task.googleCalendarEventId || !task.dueAt) continue;
    await generateHintsForTask(task as any, today).catch(() => {});
  }

  return tasks.length;
}
