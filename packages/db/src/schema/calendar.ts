import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { workspacesTable } from "./tenancy";

/**
 * Stores Google OAuth Client ID + Secret configured by the user from the UI.
 * One row per workspace. When present, these take precedence over env vars.
 */
export const googleCalendarSettingsTable = pgTable("google_calendar_settings", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .unique()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Stores Google OAuth2 tokens (access + refresh) per workspace.
 * One row per workspace — upserted on every OAuth callback so reconnecting
 * automatically replaces the old token set.
 */
export const googleCalendarTokensTable = pgTable("google_calendar_tokens", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .unique()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  /** Email of the Google account that authorized the Calendar scope */
  email: text("email"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
