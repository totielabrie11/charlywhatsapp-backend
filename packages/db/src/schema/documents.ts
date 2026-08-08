import { pgTable, serial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workspacesTable } from "./tenancy";

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("pdf"),
  size: integer("size").notNull().default(0),
  category: text("category"),
  description: text("description"),
  content: text("content"),
  indexed: boolean("indexed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // 0.1: AI queries filter on indexed=true on every request
  index("documents_indexed_idx").on(t.indexed),
  index("documents_workspace_id_idx").on(t.workspaceId),
]);

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({ id: true, createdAt: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
