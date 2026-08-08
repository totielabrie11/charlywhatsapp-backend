import { pgTable, serial, text, timestamp, integer, jsonb, unique, index } from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";
import { clientsTable } from "./clients";

/** Explainability entry: one per keyword that fired during a CIE run */
export interface AppliedRule {
  label: string;
  keyword: string;
  occurrences: number;
  delta: number;
  category: string;
  reason: string;
}

/**
 * Dynamic commercial profile per client.
 * Computed on-demand by the interest/scoring engine — never edited manually.
 * One row per client (unique on client_id).
 */
export const clientProfilesTable = pgTable("client_profiles", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),

  /**
   * Activity index based on days since last conversation:
   * very_active (<7d) | active (<30d) | inactive (<90d) | lost (≥90d or no convos)
   */
  activityIndex: text("activity_index").notNull().default("lost"),

  /** Average days between consecutive conversations (null if <2 conversations) */
  contactFrequencyDays: integer("contact_frequency_days"),

  /** Interest labels detected from conversation history via keyword rules */
  detectedInterests: jsonb("detected_interests").$type<string[]>().notNull().default([]),

  /**
   * Last detected commercial action:
   * "quote" | "complaint" | "technical" | "purchase" | "inquiry" | "follow_up" | "negotiation"
   */
  lastCommercialAction: text("last_commercial_action"),

  /** Rule-based commercial score 0–100 */
  commercialScore: integer("commercial_score").notNull().default(0),

  /** Per-component score breakdown for auditability */
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>().notNull().default({}),

  /** Snapshot counters (denormalized for fast segment filtering) */
  totalConversations: integer("total_conversations").notNull().default(0),
  openTasks: integer("open_tasks").notNull().default(0),
  openOpportunities: integer("open_opportunities").notNull().default(0),

  /** When the profile was last (re)computed */
  computedAt: timestamp("computed_at").notNull().defaultNow(),

  // ── Commercial Intelligence Engine additions ──────────────────────────────
  /** Points added by the DB-driven keyword catalog (can be negative) */
  keywordScore: integer("keyword_score").notNull().default(0),

  /** Priority determined by the CIE (A/B/C/D/E) — written only on Sync */
  enginePriority: text("engine_priority"),

  /** Stage determined by the CIE — written only on Sync */
  engineStage: text("engine_stage"),

  /**
   * Explainability log: which rules fired and by how much.
   * Array of { label, keyword, occurrences, delta, category, reason }
   */
  appliedRules: jsonb("applied_rules").$type<AppliedRule[]>().notNull().default([]),
}, (t) => [
  unique("client_profiles_client_unique").on(t.clientId),
  index("client_profiles_workspace_idx").on(t.workspaceId),
  index("client_profiles_activity_idx").on(t.activityIndex),
  index("client_profiles_score_idx").on(t.commercialScore),
]);

export type ClientProfile = typeof clientProfilesTable.$inferSelect;
