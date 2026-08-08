import { Router } from "express";
import { db } from "@workspace/db";
import { tasksTable, taskHistoryTable, clientsTable, activityLogTable } from "@workspace/db";
import { eq, desc, and, isNotNull, inArray } from "drizzle-orm";
import { logClientEvent } from "../services/clientEvents";
import { emit as socketEmit } from "../lib/socket";
import { patchCalendarEventTime } from "../services/calendarSync";

const router = Router();

// ─── Calendar event type inference ───────────────────────────────────────────
const TYPE_TO_CALENDAR_EVENT: Record<string, string> = {
  call: "llamada",
  llamada: "llamada",
  visit: "visita",
  visita: "visita",
  seguimiento: "seguimiento",
  follow_up: "seguimiento",
  followup: "seguimiento",
  reunion: "reunión",
  meeting: "reunión",
  entrega: "entrega",
  delivery: "entrega",
  capacitacion: "capacitación",
  training: "capacitación",
  presentacion: "presentación",
  presentation: "presentación",
  demo: "presentación",
};

function inferCalendarEventType(taskType: string | null | undefined): string | null {
  if (!taskType) return null;
  const normalized = taskType.toLowerCase().replace(/[áéíóú]/g, c =>
    ({ á: "a", é: "e", í: "i", ó: "o", ú: "u" }[c] ?? c)
  );
  return TYPE_TO_CALENDAR_EVENT[normalized] ?? TYPE_TO_CALENDAR_EVENT[taskType.toLowerCase()] ?? null;
}

// ─── GET /tasks ───────────────────────────────────────────────────────────────

router.get("/tasks", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { status, priority, clientId } = req.query as Record<string, string>;

  const conditions: ReturnType<typeof eq>[] = [eq(tasksTable.workspaceId, workspaceId)];
  if (status && status !== "all") conditions.push(eq(tasksTable.status, status));
  if (priority && priority !== "all") conditions.push(eq(tasksTable.priority, priority));
  if (clientId) conditions.push(eq(tasksTable.clientId, parseInt(clientId)));

  const tasks = await db.select({
    task: tasksTable,
    clientName: clientsTable.name,
  }).from(tasksTable)
    .leftJoin(clientsTable, eq(tasksTable.clientId, clientsTable.id))
    .where(and(...conditions))
    .orderBy(desc(tasksTable.createdAt));

  res.json(tasks.map(({ task, clientName }) => ({
    ...task,
    clientName: clientName ?? null,
    createdAt: task.createdAt.toISOString(),
    dueAt: task.dueAt?.toISOString() ?? null,
    followUpAt: task.followUpAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
  })));
});

// ─── POST /tasks ──────────────────────────────────────────────────────────────

router.post("/tasks", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const body = req.body;

  if (body.clientId) {
    const [clientCheck] = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(and(eq(clientsTable.id, parseInt(String(body.clientId))), eq(clientsTable.workspaceId, workspaceId)));
    if (!clientCheck) { res.status(404).json({ error: "Client not found" }); return; }
  }

  const taskType = body.type || "other";
  const calendarEventType = body.calendarEventType ?? inferCalendarEventType(taskType);

  const [task] = await db.insert(tasksTable).values({
    workspaceId,
    title: body.title,
    description: body.description ?? null,
    priority: body.priority || "medium",
    type: taskType,
    status: "pending",
    dueAt: body.dueAt ? new Date(body.dueAt) : null,
    followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
    clientId: body.clientId || null,
    conversationId: body.conversationId || null,
    assignee: body.assignee ?? null,
    tags: body.tags ?? null,
    isPinned: body.isPinned ?? false,
    googleCalendarEventId: body.googleCalendarEventId ?? null,
    calendarEventType: calendarEventType ?? null,
  }).returning();

  await db.insert(taskHistoryTable).values({
    taskId: task.id,
    workspaceId,
    event: "created",
    detail: "Tarea creada",
    actor: body.actor ?? "Operador",
  });

  // Fetch client company for task_created enrichment
  let taskClientCompany: string | null = null;
  if (task.clientId) {
    const [cl] = await db.select({ company: clientsTable.company }).from(clientsTable)
      .where(eq(clientsTable.id, task.clientId)).catch(() => []);
    taskClientCompany = cl?.company ?? null;
  }
  await db.insert(activityLogTable).values({
    workspaceId, type: "task_created", description: `Nueva tarea: ${task.title}`,
    clientName: null, companyName: taskClientCompany,
    conversationId: body.conversationId || null,
  });
  await logClientEvent({
    workspaceId,
    clientId: task.clientId,
    type: "task_created",
    detail: `Nueva tarea: ${task.title}`,
    actor: "Operador",
    relatedType: "task",
    relatedId: task.id,
  });

  // Emit calendar-eligible event so the frontend can offer to schedule it.
  // Only emitted when: has dueAt + calendarEventType AND not already synced
  // AND skipCalendarBanner is not set.
  // CalendarEventModal and CommitmentDetectedCard set skipCalendarBanner: true
  // because they handle the Calendar sync themselves.
  const skipBanner = !!(req.body as any).skipCalendarBanner;
  if (!skipBanner && task.dueAt && task.calendarEventType && !task.googleCalendarEventId) {
    // Fetch client name for the confirmation card label (best-effort).
    let calendarClientName: string | null = null;
    if (task.clientId) {
      const [cl] = await db.select({ name: clientsTable.name }).from(clientsTable)
        .where(eq(clientsTable.id, task.clientId)).catch(() => []);
      calendarClientName = cl?.name ?? null;
    }
    socketEmit(workspaceId, "task:calendar_eligible", {
      taskId: task.id,
      title: task.title,
      calendarEventType: task.calendarEventType,
      dueAt: task.dueAt.toISOString(),
      clientName: calendarClientName,
    });
  }

  res.status(201).json({
    ...task,
    clientName: null,
    createdAt: task.createdAt.toISOString(),
    dueAt: task.dueAt?.toISOString() ?? null,
    followUpAt: task.followUpAt?.toISOString() ?? null,
    completedAt: null,
  });
});

// ─── PATCH /tasks/:id ─────────────────────────────────────────────────────────

router.patch("/tasks/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Fetch current task for history diffing
  const [current] = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.workspaceId, workspaceId)));
  if (!current) { res.status(404).json({ error: "Not found" }); return; }

  const body = req.body;
  const update: Record<string, unknown> = {};
  const allowed = ["title", "description", "status", "priority", "type", "dueAt", "followUpAt", "assignee", "tags", "isPinned", "googleCalendarEventId", "calendarEventType"];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      if (key === "dueAt" || key === "followUpAt") {
        update[key] = body[key] ? new Date(body[key]) : null;
      } else {
        update[key] = body[key];
      }
    }
  }
  if (body.status === "completed" && current.status !== "completed") update.completedAt = new Date();

  const [task] = await db.update(tasksTable).set(update)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.workspaceId, workspaceId)))
    .returning();
  if (!task) { res.status(404).json({ error: "Not found" }); return; }

  // ─── Auto-log history ────────────────────────────────────────────────────────
  const historyEntries: { event: string; detail: string }[] = [];

  if (body.status !== undefined && body.status !== current.status) {
    const STATUS_LABELS: Record<string, string> = {
      pending: "Pendiente", in_progress: "En proceso", waiting_client: "Esperando cliente",
      scheduled: "Programada", postponed: "Postergada", delegated: "Delegada",
      completed: "Completada", cancelled: "Cancelada",
    };
    historyEntries.push({ event: "status_changed", detail: `Estado: ${STATUS_LABELS[current.status] ?? current.status} → ${STATUS_LABELS[body.status] ?? body.status}` });
  }
  if (body.priority !== undefined && body.priority !== current.priority) {
    const PRIORITY_LABELS: Record<string, string> = { urgent: "Urgente", high: "Alta", medium: "Media", low: "Baja" };
    historyEntries.push({ event: "priority_changed", detail: `Prioridad: ${PRIORITY_LABELS[current.priority] ?? current.priority} → ${PRIORITY_LABELS[body.priority] ?? body.priority}` });
  }
  if (body.title !== undefined && body.title !== current.title) {
    historyEntries.push({ event: "title_changed", detail: `Título cambiado` });
  }
  if (body.dueAt !== undefined) {
    historyEntries.push({ event: "date_changed", detail: `Fecha de vencimiento actualizada` });
  }
  if (body.followUpAt !== undefined) {
    historyEntries.push({ event: "followup_changed", detail: `Fecha de seguimiento actualizada` });
  }
  if (body.assignee !== undefined && body.assignee !== current.assignee) {
    historyEntries.push({ event: "assigned", detail: body.assignee ? `Asignada a: ${body.assignee}` : "Asignación eliminada" });
  }
  if (body.tags !== undefined && body.tags !== current.tags) {
    historyEntries.push({ event: "tagged", detail: "Etiquetas actualizadas" });
  }
  if (body.isPinned !== undefined && body.isPinned !== current.isPinned) {
    historyEntries.push({ event: "pinned", detail: body.isPinned ? "Tarea fijada" : "Tarea desfijada" });
  }
  if (body.description !== undefined && body.description !== current.description) {
    historyEntries.push({ event: "description_changed", detail: "Descripción actualizada" });
  }

  if (historyEntries.length > 0) {
    await db.insert(taskHistoryTable).values(
      historyEntries.map(e => ({
        taskId: id,
        workspaceId,
        event: e.event,
        detail: e.detail,
        actor: body.actor ?? "Operador",
      }))
    );
  }

  // ─── Client events ───────────────────────────────────────────────────────────
  if (body.status === "completed" && current.status !== "completed") {
    let resolvedClientName: string | null = null;
    if (task.clientId) {
      const [cl] = await db.select({ name: clientsTable.name }).from(clientsTable)
        .where(and(eq(clientsTable.id, task.clientId), eq(clientsTable.workspaceId, workspaceId)));
      resolvedClientName = cl?.name ?? null;
    }
    // Fetch company for task_completed
    let taskCompletedCompany: string | null = null;
    if (task.clientId) {
      const [cl] = await db.select({ company: clientsTable.company }).from(clientsTable)
        .where(eq(clientsTable.id, task.clientId)).catch(() => []);
      taskCompletedCompany = cl?.company ?? null;
    }
    await db.insert(activityLogTable).values({
      workspaceId, type: "task_completed", description: `Tarea completada: ${task.title}`,
      clientName: resolvedClientName, companyName: taskCompletedCompany,
      conversationId: task.conversationId || null,
    });
    await logClientEvent({ workspaceId, clientId: task.clientId, type: "task_completed", detail: `Tarea completada: ${task.title}`, actor: "Operador", relatedType: "task", relatedId: task.id });
  } else if (body.status === "cancelled" && current.status !== "cancelled") {
    await logClientEvent({ workspaceId, clientId: task.clientId, type: "task_cancelled", detail: `Tarea cancelada: ${task.title}`, actor: "Operador", relatedType: "task", relatedId: task.id });
  } else if (historyEntries.length > 0) {
    await logClientEvent({ workspaceId, clientId: task.clientId, type: "task_updated", detail: `Tarea actualizada: ${task.title} (${historyEntries.map(e => e.event).join(", ")})`, actor: "Operador", relatedType: "task", relatedId: task.id });
  }

  // If dueAt changed on a task that's already synced to Google Calendar,
  // patch the calendar event's time asynchronously (non-blocking).
  if (body.dueAt !== undefined && task.googleCalendarEventId && task.dueAt) {
    void patchCalendarEventTime(workspaceId, task.googleCalendarEventId, task.dueAt);
  }

  res.json({
    ...task,
    clientName: null,
    createdAt: task.createdAt.toISOString(),
    dueAt: task.dueAt?.toISOString() ?? null,
    followUpAt: task.followUpAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
  });
});

// ─── DELETE /tasks/:id ────────────────────────────────────────────────────────

router.delete("/tasks/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [task] = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.workspaceId, workspaceId)));

  if (task) {
    await logClientEvent({ workspaceId, clientId: task.clientId, type: "task_cancelled", detail: `Tarea eliminada: ${task.title}`, actor: "Operador", relatedType: "task", relatedId: task.id });
  }

  await db.delete(tasksTable).where(and(eq(tasksTable.id, id), eq(tasksTable.workspaceId, workspaceId)));
  res.status(204).end();
});

// ─── POST /tasks/:id/duplicate ────────────────────────────────────────────────

router.post("/tasks/:id/duplicate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [original] = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.id, id), eq(tasksTable.workspaceId, workspaceId)));
  if (!original) { res.status(404).json({ error: "Not found" }); return; }

  const [dup] = await db.insert(tasksTable).values({
    workspaceId,
    title: `Copia — ${original.title}`,
    description: original.description,
    priority: original.priority,
    type: original.type,
    status: "pending",
    dueAt: original.dueAt,
    followUpAt: original.followUpAt,
    clientId: original.clientId,
    conversationId: original.conversationId,
    assignee: original.assignee,
    tags: original.tags,
    isPinned: false,
    // Carry event type but NOT the calendar event ID — duplicates are new tasks
    calendarEventType: original.calendarEventType,
    googleCalendarEventId: null,
  }).returning();

  await db.insert(taskHistoryTable).values({
    taskId: dup.id,
    workspaceId,
    event: "created",
    detail: `Duplicada desde tarea #${id}: ${original.title}`,
    actor: "Operador",
  });

  res.status(201).json({
    ...dup,
    clientName: null,
    createdAt: dup.createdAt.toISOString(),
    dueAt: dup.dueAt?.toISOString() ?? null,
    followUpAt: dup.followUpAt?.toISOString() ?? null,
    completedAt: null,
  });
});

// ─── GET /tasks/calendar-linked ───────────────────────────────────────────────
// Returns tasks that have both dueAt and googleCalendarEventId set.
// Used by the "Agenda Comercial" list view in the Calendar page.

router.get("/tasks/calendar-linked", async (req, res) => {
  const workspaceId = req.workspaceId!;

  const tasks = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      dueAt: tasksTable.dueAt,
      calendarEventType: tasksTable.calendarEventType,
      status: tasksTable.status,
      priority: tasksTable.priority,
      clientId: tasksTable.clientId,
      clientName: clientsTable.name,
      clientCompany: clientsTable.company,
      googleCalendarEventId: tasksTable.googleCalendarEventId,
    })
    .from(tasksTable)
    .leftJoin(clientsTable, eq(tasksTable.clientId, clientsTable.id))
    .where(
      and(
        eq(tasksTable.workspaceId, workspaceId),
        isNotNull(tasksTable.dueAt),
        isNotNull(tasksTable.googleCalendarEventId),
        inArray(tasksTable.status, ["pending", "in_progress", "scheduled", "waiting_client"]),
      ),
    )
    .orderBy(tasksTable.dueAt);

  res.json(
    tasks.map(t => ({
      ...t,
      dueAt: t.dueAt?.toISOString() ?? null,
    })),
  );
});

// ─── GET /tasks/:id/history ───────────────────────────────────────────────────

router.get("/tasks/:id/history", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const history = await db.select().from(taskHistoryTable)
    .where(and(eq(taskHistoryTable.taskId, id), eq(taskHistoryTable.workspaceId, workspaceId)))
    .orderBy(desc(taskHistoryTable.createdAt));

  res.json(history.map(h => ({ ...h, createdAt: h.createdAt.toISOString() })));
});

export default router;
