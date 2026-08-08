import { pgTable, serial, text, timestamp, integer, index, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { conversationsTable } from "./conversations";
import { workspacesTable } from "./tenancy";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  priority: text("priority").notNull().default("medium"),
  type: text("type").notNull().default("other"),
  dueAt: timestamp("due_at"),
  followUpAt: timestamp("follow_up_at"),
  completedAt: timestamp("completed_at"),
  clientId: integer("client_id").references(() => clientsTable.id),
  conversationId: integer("conversation_id").references(() => conversationsTable.id),
  assignee: text("assignee"),
  tags: text("tags"), // JSON string: '["tag1","tag2"]'
  isPinned: boolean("is_pinned").default(false),
  googleCalendarEventId: text("google_calendar_event_id"),
  calendarEventType: text("calendar_event_type"), // llamada|visita|seguimiento|reunión|entrega|capacitación|presentación|otro
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("tasks_status_idx").on(t.status),
  index("tasks_priority_idx").on(t.priority),
  index("tasks_client_id_idx").on(t.clientId),
  index("tasks_conversation_id_idx").on(t.conversationId),
  index("tasks_workspace_id_idx").on(t.workspaceId),
]);

export const taskHistoryTable = pgTable("task_history", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  event: text("event").notNull(),
  detail: text("detail").notNull(),
  actor: text("actor"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("task_history_task_id_idx").on(t.taskId),
]);

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;

// ── Calendar event hints (AI-generated daily prep hints for synced tasks) ──────
export const calendarEventHintsTable = pgTable("calendar_event_hints", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  calendarEventId: text("calendar_event_id").notNull(),
  hints: text("hints").notNull(), // JSON array of strings
  generatedAt: text("generated_at").notNull(), // YYYY-MM-DD for dedup
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("cal_event_hints_task_id_idx").on(t.taskId),
  index("cal_event_hints_workspace_date_idx").on(t.workspaceId, t.generatedAt),
]);
