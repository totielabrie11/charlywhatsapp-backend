import { Router } from "express";
import { db } from "@workspace/db";
import {
  conversationsTable,
  tasksTable,
  opportunitiesTable,
  activityLogTable,
  clientsTable,
  messagesTable,
} from "@workspace/db";
import { eq, sql, desc, gte, or, gt, and } from "drizzle-orm";

const router = Router();

router.get("/dashboard/stats", async (req, res) => {
  const workspaceId = req.workspaceId!;

  const [convStats] = await db.select({
    active: sql<number>`count(*) filter (where ${conversationsTable.status} = 'active')::int`,
    waiting: sql<number>`count(*) filter (where ${conversationsTable.status} = 'waiting' or ${conversationsTable.status} = 'waiting_reply')::int`,
    unread: sql<number>`coalesce(sum(${conversationsTable.unreadCount}), 0)::int`,
  }).from(conversationsTable).where(eq(conversationsTable.workspaceId, workspaceId));

  const [taskStats] = await db.select({
    pending: sql<number>`count(*) filter (where ${tasksTable.status} = 'pending' and ${tasksTable.type} = 'send_quote')::int`,
    overdue: sql<number>`count(*) filter (where ${tasksTable.status} = 'overdue' or (${tasksTable.status} = 'pending' and ${tasksTable.dueAt} < now()))::int`,
    openComplaints: sql<number>`count(*) filter (where ${tasksTable.type} = 'other' and ${tasksTable.status} = 'pending')::int`,
  }).from(tasksTable).where(eq(tasksTable.workspaceId, workspaceId));

  const [pipelineStats] = await db.select({
    totalValue: sql<number>`coalesce(sum(${opportunitiesTable.value}), 0)`,
    closedSales: sql<number>`count(*) filter (where ${opportunitiesTable.stage} = 'sale')::int`,
    conversionRate: sql<number>`round(count(*) filter (where ${opportunitiesTable.stage} in ('sale', 'delivery', 'after_sale'))::numeric / greatest(count(*), 1) * 100, 1)`,
  }).from(opportunitiesTable).where(eq(opportunitiesTable.workspaceId, workspaceId));

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const [clientStats] = await db.select({
    newClientsThisMonth: sql<number>`count(*)::int`,
  }).from(clientsTable).where(and(
    eq(clientsTable.workspaceId, workspaceId),
    gte(clientsTable.createdAt, thirtyDaysAgo),
  ));

  // Calculate average response time from messages (minutes between inbound → first outbound response)
  // Scoped to this workspace's conversations
  const workspaceConvIds = await db.select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(eq(conversationsTable.workspaceId, workspaceId));
  const convIdList = workspaceConvIds.map(c => c.id);

  let avgResponseMinutes = 0;
  if (convIdList.length > 0) {
    const responseRows = await db.execute(sql`
      SELECT COALESCE(AVG(diff_minutes), 0)::int as avg_minutes
      FROM (
        SELECT
          EXTRACT(EPOCH FROM (
            (SELECT m2.sent_at FROM ${messagesTable} m2
             WHERE m2.conversation_id = m1.conversation_id
             AND m2.direction = 'outbound'
             AND m2.sent_at > m1.sent_at
             ORDER BY m2.sent_at LIMIT 1)
            - m1.sent_at
          )) / 60.0 as diff_minutes
        FROM ${messagesTable} m1
        WHERE m1.direction = 'inbound'
          AND m1.conversation_id = ANY(${sql.raw(`ARRAY[${convIdList.join(",")}]::int[]`)})
      ) t
      WHERE diff_minutes IS NOT NULL AND diff_minutes < 1440
    `);
    const responseTime = (responseRows as any).rows?.[0] ?? (responseRows as any)[0] ?? null;
    avgResponseMinutes = (responseTime as any)?.avg_minutes ?? 0;
  }

  res.json({
    waitingClients: convStats.waiting ?? 0,
    pendingQuotes: taskStats.pending ?? 0,
    closedSales: pipelineStats.closedSales ?? 0,
    openComplaints: taskStats.openComplaints ?? 0,
    unrepliedClients: convStats.unread ?? 0,
    avgResponseMinutes,
    activeConversations: convStats.active ?? 0,
    tasksOverdue: taskStats.overdue ?? 0,
    totalPipelineValue: pipelineStats.totalValue ?? 0,
    newClientsThisMonth: clientStats.newClientsThisMonth ?? 0,
    conversionRate: pipelineStats.conversionRate ?? 0,
  });
});

router.get("/dashboard/activity", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const limit  = Math.min(parseInt((req.query.limit  as string) || "50"), 100);
  const offset = Math.max(parseInt((req.query.offset as string) || "0"),  0);

  // JOIN conversations → clients to enrich events that have a conversationId
  const rows = await db
    .select({
      id:             activityLogTable.id,
      type:           activityLogTable.type,
      description:    activityLogTable.description,
      clientName:     activityLogTable.clientName,
      companyName:    activityLogTable.companyName,
      conversationId: activityLogTable.conversationId,
      createdAt:      activityLogTable.createdAt,
      // from conversation (nullable join)
      contactName:    conversationsTable.contactName,
      contactPhone:   conversationsTable.contactPhone,
      convStatus:     conversationsTable.status,
      // from client linked to conversation (nullable join)
      linkedClientName:    clientsTable.name,
      linkedClientCompany: clientsTable.company,
    })
    .from(activityLogTable)
    .leftJoin(
      conversationsTable,
      eq(activityLogTable.conversationId, conversationsTable.id),
    )
    .leftJoin(
      clientsTable,
      eq(conversationsTable.clientId, clientsTable.id),
    )
    .where(eq(activityLogTable.workspaceId, workspaceId))
    .orderBy(desc(activityLogTable.createdAt))
    .limit(limit)
    .offset(offset);

  // Count total for pagination
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(activityLogTable)
    .where(eq(activityLogTable.workspaceId, workspaceId));

  const enriched = rows.map(r => {
    // Resolved contact display name (prefer conversation name, fall back to stored clientName)
    const resolvedContact = r.contactName || r.clientName || null;
    // Resolved company (prefer client company, fall back to stored companyName)
    const resolvedCompany = r.linkedClientCompany || r.companyName || null;

    return {
      id:             r.id,
      type:           r.type,
      description:    r.description,
      createdAt:      r.createdAt.toISOString(),
      conversationId: r.conversationId,
      contactName:    resolvedContact,
      contactPhone:   r.contactPhone || null,
      companyName:    resolvedCompany,
      convStatus:     r.convStatus || null,
    };
  });

  res.json({ items: enriched, total, limit, offset });
});

/**
 * GET /dashboard/action-items
 * Returns a unified, priority-sorted list of operational action items:
 * - Pending / in-progress tasks (from tasks table)
 * - Unanswered client conversations (unreadCount > 0)
 * Sorted: urgent → high → medium → low, then by urgency metric DESC.
 */
router.get("/dashboard/action-items", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const now = new Date();

  // 1. Pending / in-progress tasks with client name
  const taskRows = await db.select({
    task: tasksTable,
    clientName: clientsTable.name,
  }).from(tasksTable)
    .leftJoin(clientsTable, eq(tasksTable.clientId, clientsTable.id))
    .where(and(
      eq(tasksTable.workspaceId, workspaceId),
      or(eq(tasksTable.status, "pending"), eq(tasksTable.status, "in_progress")),
    ))
    .orderBy(tasksTable.createdAt);

  // 2. Unanswered conversations (unread messages from client)
  const unansweredRows = await db.select({
    id: conversationsTable.id,
    contactName: conversationsTable.contactName,
    unreadCount: conversationsTable.unreadCount,
    lastMessageAt: conversationsTable.lastMessageAt,
    clientName: clientsTable.name,
  }).from(conversationsTable)
    .leftJoin(clientsTable, eq(conversationsTable.clientId, clientsTable.id))
    .where(and(
      eq(conversationsTable.workspaceId, workspaceId),
      gt(conversationsTable.unreadCount, 0),
    ));

  type ActionItemPriority = "urgent" | "high" | "medium" | "low";

  interface ActionItem {
    id: string;
    sourceType: "task" | "unanswered_client";
    priority: ActionItemPriority;
    title: string;
    clientName: string | null;
    conversationId: number | null;
    taskId: number | null;
    waitingHours: number | null;
    dueAt: string | null;
    taskType: string | null;
    taskStatus: string | null;
  }

  const items: ActionItem[] = [];

  // Build items from tasks
  for (const { task, clientName } of taskRows) {
    const isOverdue = task.dueAt != null && task.dueAt < now;
    let priority: ActionItemPriority;
    if (isOverdue || task.priority === "urgent") {
      priority = "urgent";
    } else if (task.priority === "high") {
      priority = "high";
    } else if (task.priority === "medium" || task.priority === "normal") {
      priority = "medium";
    } else {
      priority = task.priority === "low" ? "low" : "medium";
    }

    items.push({
      id: `task-${task.id}`,
      sourceType: "task",
      priority,
      title: task.title,
      clientName: clientName ?? null,
      conversationId: task.conversationId ?? null,
      taskId: task.id,
      waitingHours: null,
      dueAt: task.dueAt?.toISOString() ?? null,
      taskType: task.type,
      taskStatus: task.status,
    });
  }

  // Build items from unanswered conversations
  // Avoid duplicating if there's already a task for the same conversation
  const taskConvIds = new Set(taskRows.map(r => r.task.conversationId).filter(Boolean));

  for (const conv of unansweredRows) {
    if (taskConvIds.has(conv.id)) continue; // already covered by a task

    const waitingMs = now.getTime() - new Date(conv.lastMessageAt).getTime();
    const waitingHours = waitingMs / (1000 * 60 * 60);

    let priority: ActionItemPriority;
    if (waitingHours >= 24 * 5) priority = "urgent";       // 5+ days
    else if (waitingHours >= 3) priority = "high";          // 3+ hours
    else priority = "medium";                               // < 3h

    const hoursText = waitingHours < 1
      ? `${Math.max(1, Math.round(waitingHours * 60))} min`
      : waitingHours < 24
      ? `${Math.round(waitingHours)} h`
      : `${Math.round(waitingHours / 24)} días`;

    items.push({
      id: `conv-${conv.id}`,
      sourceType: "unanswered_client",
      priority,
      title: `Cliente esperando respuesta hace ${hoursText}`,
      clientName: conv.clientName ?? conv.contactName,
      conversationId: conv.id,
      taskId: null,
      waitingHours,
      dueAt: null,
      taskType: null,
      taskStatus: null,
    });
  }

  // Sort: urgent > high > medium > low, then within each tier by urgency:
  //   - unanswered_client items: more waiting hours first
  //   - task items: nearest dueAt first (overdue = very high score), then by createdAt ASC
  const priorityScore: Record<ActionItemPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
  items.sort((a, b) => {
    const pd = priorityScore[b.priority] - priorityScore[a.priority];
    if (pd !== 0) return pd;
    // within same tier, derive an urgency score (higher = more urgent)
    const urgencyScore = (item: typeof a): number => {
      if (item.waitingHours != null) return item.waitingHours; // more hours waiting = more urgent
      if (item.dueAt) {
        const diffHours = (now.getTime() - new Date(item.dueAt).getTime()) / (1000 * 60 * 60);
        return diffHours; // positive = overdue (more overdue = higher score), negative = upcoming (still counts)
      }
      return 0;
    };
    return urgencyScore(b) - urgencyScore(a);
  });

  res.json(items);
});

export default router;
