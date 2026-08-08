import { pgTable, serial, text, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { workspacesTable } from "./tenancy";

export const opportunitiesTable = pgTable("opportunities", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  title: text("title").notNull(),
  clientId: integer("client_id").references(() => clientsTable.id),
  /**
   * The WhatsApp conversation that originated this opportunity (nullable —
   * opportunities created manually or from other sources have no conversation).
   * Not a FK so we avoid circular deps between pipeline and conversations schemas.
   */
  conversationId: integer("conversation_id"),
  stage: text("stage").notNull().default("prospect"),
  value: real("value").notNull().default(0),
  probability: integer("probability").notNull().default(50),
  product: text("product"),
  description: text("description"),
  expectedCloseAt: timestamp("expected_close_at"),
  /** How this opportunity was created — lets downstream AI/reporting distinguish signal-driven records from manual ones */
  source: text("source").notNull().default("manual"),
  /**
   * Final outcome: "open" (active), "won" (venta cerrada) or "lost" (perdida confirmada).
   * Once set to won/lost the record is never deleted — it lives forever on the client
   * for marketing and reporting purposes.
   */
  outcome: text("outcome").notNull().default("open"),
  /** Timestamp when the opportunity was won or lost */
  closedAt: timestamp("closed_at"),
  /** Optional notes on why the deal was won or lost */
  outcomeNotes: text("outcome_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("opportunities_stage_idx").on(t.stage),
  index("opportunities_outcome_idx").on(t.outcome),
  // 0.1: FK index — dashboard queries opportunities by clientId frequently
  index("opportunities_client_id_idx").on(t.clientId),
  index("opportunities_workspace_id_idx").on(t.workspaceId),
]);

export const insertOpportunitySchema = createInsertSchema(opportunitiesTable).omit({ id: true, createdAt: true });
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
export type Opportunity = typeof opportunitiesTable.$inferSelect;
