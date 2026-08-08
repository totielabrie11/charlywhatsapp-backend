/**
 * Fase 4.2: Token usage tracking.
 * Logged after every LLM API call — used to monitor costs and debug AI usage.
 */
import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workspacesTable } from "./tenancy";

export const tokenUsageTable = pgTable("token_usage", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspacesTable.id),
  model: text("model").notNull(),
  endpoint: text("endpoint").notNull(),  // "generate_suggestion" | "suggest_reply" | "analyze" | "catalog_vision"
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("token_usage_endpoint_idx").on(t.endpoint),
  index("token_usage_created_at_idx").on(t.createdAt),
  index("token_usage_workspace_id_idx").on(t.workspaceId),
]);

export const insertTokenUsageSchema = createInsertSchema(tokenUsageTable).omit({ id: true, createdAt: true });
export type InsertTokenUsage = z.infer<typeof insertTokenUsageSchema>;
export type TokenUsage = typeof tokenUsageTable.$inferSelect;
