import { pgTable, serial, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";

/**
 * A single filter rule within a segment.
 * Field + operator + value triplet — combined with AND logic.
 */
export type FilterOperator =
  | "eq"        // field == value
  | "neq"       // field != value
  | "gt_days"   // days since event > value (e.g. "last conversation more than X days ago")
  | "lt_days"   // days since event < value (e.g. "last conversation within X days")
  | "gte"       // field >= value (numeric)
  | "lte"       // field <= value (numeric)
  | "in"        // field IN value[]
  | "not_in"    // field NOT IN value[]
  | "contains"  // field ILIKE %value%
  | "is_true"   // boolean field is true
  | "is_false"; // boolean field is false

export type FilterRule = {
  /** Unique React key */
  id: string;
  /** Field name — see FILTER_FIELD_NAMES in segments route */
  field: string;
  operator: FilterOperator;
  /** String, string[], number, or null */
  value: string | string[] | number | null;
};

/**
 * Saved segment definition.
 * Filters are evaluated at query time so the segment always reflects current data.
 */
export type PinnedClient = { id: number; name: string; phone: string | null };

export const marketingSegmentsTable = pgTable("marketing_segments", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  /** Ordered list of FilterRule objects — combined with AND logic */
  filters: jsonb("filters").$type<FilterRule[]>().notNull().default([]),
  /** Clients manually pinned into the segment (survive filter re-evaluations) */
  pinnedClients: jsonb("pinned_clients").$type<PinnedClient[]>().notNull().default([]),
  /** Client IDs explicitly excluded from the auto-computed list */
  excludedClientIds: jsonb("excluded_client_ids").$type<number[]>().notNull().default([]),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("marketing_segments_workspace_idx").on(t.workspaceId),
]);

export type MarketingSegment = typeof marketingSegmentsTable.$inferSelect;
