import {
  pgTable, serial, text, timestamp, integer, index,
} from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";

/**
 * Editable keyword catalog for the Commercial Intelligence Engine.
 * Each keyword has a configurable weight (positive = bonus, negative = penalty)
 * and a category label for grouping in the UI.
 *
 * When a workspace has no rows, the engine falls back to the built-in INTEREST_MAP
 * defined in clientProfiles.ts so zero-config still works.
 */
export const commercialKeywordsTable = pgTable("commercial_keywords", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  keyword: text("keyword").notNull(),
  /** Positive = score bonus, negative = penalty */
  weight: integer("weight").notNull().default(5),
  /** Free-form grouping label shown in the settings UI */
  category: text("category").notNull().default("general"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("commercial_keywords_workspace_idx").on(t.workspaceId),
]);

/**
 * Configurable priority and stage thresholds.
 * type = "priority" → value ∈ { A, B, C, D, E }
 * type = "stage"    → value = stage name (e.g. "negociacion")
 *
 * When no rows exist for a workspace the engine uses hardcoded defaults.
 */
export const commercialRulesTable = pgTable("commercial_rules", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  /** "priority" | "stage" */
  type: text("type").notNull(),
  minScore: integer("min_score").notNull().default(0),
  maxScore: integer("max_score").notNull().default(100),
  /** For priority: A|B|C|D|E  — for stage: any stage slug */
  value: text("value").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("commercial_rules_workspace_idx").on(t.workspaceId),
]);

export type CommercialKeyword = typeof commercialKeywordsTable.$inferSelect;
export type CommercialRule    = typeof commercialRulesTable.$inferSelect;
