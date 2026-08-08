import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";
import { marketingCampaignsTable } from "./marketing";

// ─── Campaign Events ──────────────────────────────────────────────────────────
// Append-only audit log of lifecycle events for each campaign.
// One row per event; used to display a per-campaign event history timeline.
export const campaignEventsTable = pgTable("campaign_events", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  campaignId: integer("campaign_id").notNull().references(() => marketingCampaignsTable.id, { onDelete: "cascade" }),
  /**
   * created | scheduled | schedule_changed | schedule_cancelled
   * send_started | paused | resumed | cancelled | finished | forced | error
   */
  eventType: text("event_type").notNull(),
  description: text("description"),
  /** Clerk user ID or "scheduler" for automated events */
  actor: text("actor"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("campaign_events_campaign_idx").on(t.campaignId),
  index("campaign_events_workspace_idx").on(t.workspaceId),
]);

export type CampaignEvent = typeof campaignEventsTable.$inferSelect;
export type InsertCampaignEvent = typeof campaignEventsTable.$inferInsert;
