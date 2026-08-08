import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workspacesTable } from "./tenancy";

export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  type: text("type").notNull(),
  description: text("description").notNull(),
  clientName: text("client_name"),
  companyName: text("company_name"),
  conversationId: integer("conversation_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("activity_log_created_idx").on(t.createdAt),
  index("activity_log_workspace_id_idx").on(t.workspaceId),
  index("activity_log_conv_id_idx").on(t.conversationId),
]);

export const insertActivityLogSchema = createInsertSchema(activityLogTable).omit({ id: true, createdAt: true });
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogTable.$inferSelect;
