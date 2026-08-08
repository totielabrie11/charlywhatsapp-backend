import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";
import { clientsTable } from "./clients";
import { marketingCampaignsTable } from "./marketing";

// ─── Campaign Recipients ──────────────────────────────────────────────────────
// One row per (campaign, client) pair. Created when expanding a segment or
// adding recipients manually. Status tracks the send lifecycle.
export const campaignRecipientsTable = pgTable("campaign_recipients", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  campaignId: integer("campaign_id").notNull().references(() => marketingCampaignsTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").references(() => clientsTable.id),
  phoneNumber: text("phone_number").notNull(),
  clientName: text("client_name").notNull().default(""),
  /** pending | sent | failed | excluded */
  status: text("status").notNull().default("pending"),
  /** Error message if status = failed */
  error: text("error"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("campaign_recipients_campaign_idx").on(t.campaignId),
  index("campaign_recipients_status_idx").on(t.status),
  index("campaign_recipients_workspace_idx").on(t.workspaceId),
]);

export type CampaignRecipient = typeof campaignRecipientsTable.$inferSelect;
export type InsertCampaignRecipient = typeof campaignRecipientsTable.$inferInsert;

// ─── Campaign Run Logs ─────────────────────────────────────────────────────────
// Historical record of each execution attempt (send, pause+resume counts as one
// run if the run_log row is kept open until final completion/cancellation).
export const campaignRunLogsTable = pgTable("campaign_run_logs", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  campaignId: integer("campaign_id").notNull().references(() => marketingCampaignsTable.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  totalSent: integer("total_sent").notNull().default(0),
  totalFailed: integer("total_failed").notNull().default(0),
  segmentId: integer("segment_id"),
  templateId: integer("template_id"),
  initiatedBy: text("initiated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("campaign_run_logs_campaign_idx").on(t.campaignId),
  index("campaign_run_logs_workspace_idx").on(t.workspaceId),
]);

export type CampaignRunLog = typeof campaignRunLogsTable.$inferSelect;
export type InsertCampaignRunLog = typeof campaignRunLogsTable.$inferInsert;
