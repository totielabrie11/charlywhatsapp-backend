import { pgTable, serial, text, timestamp, integer, bigint, jsonb, index } from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";

// ─── Marketing Assets (file library) ─────────────────────────────────────────
// Reusable files that can be attached to multiple templates and campaigns.
export const marketingAssetsTable = pgTable("marketing_assets", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  /** File size in bytes */
  size: bigint("size", { mode: "number" }).notNull().default(0),
  /** Public URL or base64 data URL */
  url: text("url").notNull(),
  /** Thumbnail URL for images/video — null for audio/docs */
  thumbnailUrl: text("thumbnail_url"),
  /** Clerk user ID of the uploader */
  uploadedBy: text("uploaded_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("marketing_assets_workspace_idx").on(t.workspaceId),
]);

export type MarketingAsset = typeof marketingAssetsTable.$inferSelect;
export type InsertMarketingAsset = typeof marketingAssetsTable.$inferInsert;

// ─── Marketing Templates ──────────────────────────────────────────────────────
// Rich-text message templates with optional file attachments.
// Each edit creates a new version (bumps `version`); campaigns store a snapshot
// so historical sends are never affected by future template edits.
export const marketingTemplatesTable = pgTable("marketing_templates", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  /** Rich-text body (plain text with optional line breaks; future: markdown) */
  bodyText: text("body_text").notNull().default(""),
  /** Ordered list of asset IDs to attach */
  attachmentIds: jsonb("attachment_ids").$type<number[]>().notNull().default([]),
  /** Incremented on every save so campaigns can detect drift */
  version: integer("version").notNull().default(1),
  /** Clerk user ID of the creator */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("marketing_templates_workspace_idx").on(t.workspaceId),
]);

export type MarketingTemplate = typeof marketingTemplatesTable.$inferSelect;
export type InsertMarketingTemplate = typeof marketingTemplatesTable.$inferInsert;

// ─── Marketing Campaigns ──────────────────────────────────────────────────────
// A campaign is a named send event targeting a segment of clients.
// `templateSnapshot` preserves the template body + attachments at the moment
// the campaign was created or finalized — guarantees historical fidelity even
// when the source template is later edited or deleted.
export const marketingCampaignsTable = pgTable("marketing_campaigns", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * draft | configuring | ready | sending | paused | finished | cancelled | with_errors
   * (Legacy values "scheduled" | "sent" | "archived" still accepted for old rows)
   */
  status: text("status").notNull().default("draft"),
  /** Hex color for visual identification in the campaign list */
  color: text("color"),
  /** Short campaign objective / goal description */
  objective: text("objective"),
  /** Internal notes visible only to the workspace team */
  internalNotes: text("internal_notes"),
  /** Running tally of successfully sent messages (updated by the queue) */
  sentCount: integer("sent_count").notNull().default(0),
  /** Running tally of failed sends */
  failedCount: integer("failed_count").notNull().default(0),
  /** When the queue started sending for this campaign */
  startedAt: timestamp("started_at"),
  /** When the queue finished (successfully or cancelled) */
  finishedAt: timestamp("finished_at"),
  /** Reference to the live template (nullable — snapshot is the source of truth) */
  templateId: integer("template_id").references(() => marketingTemplatesTable.id),
  /**
   * Immutable copy of the template at creation/finalization time.
   * Shape: { name, bodyText, attachmentIds, version, capturedAt }
   * This is the field that guarantees versionado — editing the source template
   * never changes what was actually sent in old campaigns.
   */
  templateSnapshot: jsonb("template_snapshot").$type<{
    name: string;
    bodyText: string;
    attachmentIds: number[];
    version: number;
    capturedAt: string;
  } | null>().default(null),
  /** FK to the live segment definition — evaluated at send time */
  segmentId: integer("segment_id"),
  /** Snapshot of filters at campaign send time (for historical audit) */
  segmentFilter: jsonb("segment_filter").$type<Record<string, unknown> | null>().default(null),
  /** ISO datetime — only set when status = "scheduled" */
  scheduledAt: timestamp("scheduled_at"),
  /** IANA timezone string used when scheduling (e.g. "America/Argentina/Buenos_Aires") */
  scheduledTimezone: text("scheduled_timezone"),
  /** ISO datetime — only set when status = "sent" */
  sentAt: timestamp("sent_at"),
  /** Recipient count captured at send time */
  recipientCount: integer("recipient_count"),
  /** Clerk user ID of the creator */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("marketing_campaigns_workspace_idx").on(t.workspaceId),
  index("marketing_campaigns_status_idx").on(t.status),
  index("marketing_campaigns_segment_idx").on(t.segmentId),
]);

export type MarketingCampaign = typeof marketingCampaignsTable.$inferSelect;
export type InsertMarketingCampaign = typeof marketingCampaignsTable.$inferInsert;
