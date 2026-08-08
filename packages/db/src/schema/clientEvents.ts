import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { workspacesTable } from "./tenancy";

// Uniform, append-only event log — the "memoria histórica" of a client.
// Every relevant action anywhere in the app (messages, tasks, opportunities,
// edits, etc.) inserts one row here so the client's timeline can be
// reconstructed by simply reading these rows in chronological order.
// Rows are never deleted or mutated by normal app flows.
export const clientEventsTable = pgTable("client_events", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  clientId: integer("client_id").notNull().references(() => clientsTable.id),
  type: text("type").notNull(),
  icon: text("icon").notNull().default("circle"),
  actor: text("actor"),
  detail: text("detail").notNull(),
  relatedType: text("related_type"),
  relatedId: integer("related_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("client_events_client_id_idx").on(t.clientId),
  index("client_events_created_idx").on(t.createdAt),
  index("client_events_workspace_id_idx").on(t.workspaceId),
]);

export const insertClientEventSchema = createInsertSchema(clientEventsTable).omit({ id: true, createdAt: true });
export type InsertClientEvent = z.infer<typeof insertClientEventSchema>;
export type ClientEvent = typeof clientEventsTable.$inferSelect;
