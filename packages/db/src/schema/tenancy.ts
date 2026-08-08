import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A workspace is the unit of data isolation and ownership. Every row of
 * business data (clients, conversations, tasks, settings, WhatsApp session,
 * etc.) belongs to exactly one workspace. Today every workspace has exactly
 * one profile (one Google account = one workspace), but the two entities are
 * modeled separately on purpose so a future "invite a teammate" feature can
 * let multiple profiles share one workspace without another migration.
 */
export const workspacesTable = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * One profile per authenticated Google/Clerk identity. `clerkUserId` is the
 * Clerk `sub` — the only thing we trust to identify "who is making this
 * request". Never scope data by email; emails can be reused/changed upstream.
 */
export const profilesTable = pgTable("profiles", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email").notNull(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("profiles_workspace_id_idx").on(t.workspaceId),
]);

export const insertWorkspaceSchema = createInsertSchema(workspacesTable).omit({ id: true, createdAt: true });
export const insertProfileSchema = createInsertSchema(profilesTable).omit({ id: true, createdAt: true });
export type InsertWorkspace = z.infer<typeof insertWorkspaceSchema>;
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Workspace = typeof workspacesTable.$inferSelect;
export type Profile = typeof profilesTable.$inferSelect;
