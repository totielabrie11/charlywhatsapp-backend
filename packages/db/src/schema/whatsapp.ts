import { pgTable, serial, text, boolean, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workspacesTable } from "./tenancy";

export const whatsappConfigTable = pgTable("whatsapp_config", {
  id: serial("id").primaryKey(),
  // One row per workspace — each workspace has its own, fully independent
  // WhatsApp connection/session status.
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  state: text("state").notNull().default("disconnected"),
  phoneNumber: text("phone_number"),
  displayName: text("display_name"),
  qrCode: text("qr_code"),
  autoReply: boolean("auto_reply").notNull().default(false),
  travelMode: boolean("travel_mode").notNull().default(false),
  connectedAt: timestamp("connected_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("whatsapp_config_workspace_id_uniq").on(t.workspaceId),
]);

export const insertWhatsappConfigSchema = createInsertSchema(whatsappConfigTable).omit({ id: true, updatedAt: true });
export type InsertWhatsappConfig = z.infer<typeof insertWhatsappConfigSchema>;
export type WhatsappConfig = typeof whatsappConfigTable.$inferSelect;

/**
 * Stores the serialised Baileys auth-state files (creds.json + keys) as a
 * single JSON blob so the WhatsApp session survives across Replit redeploys.
 * Only one row is ever present (the active session).
 */
export const waCredentialsTable = pgTable("wa_credentials", {
  id: serial("id").primaryKey(),
  /** One credentials row per workspace — each workspace's Baileys session is independent. */
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  /** JSON object mapping filename → file-content for every file in AUTH_DIR */
  data: text("data").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wa_credentials_workspace_id_uniq").on(t.workspaceId),
]);

/**
 * Single-instance lock for the live Baileys socket.
 * Autoscale can briefly run an old and a new instance side by side during a
 * redeploy; only the instance holding this lock (a fresh heartbeat within
 * the TTL) is allowed to open a WhatsApp socket, which prevents the two
 * instances from authenticating the same session at once (the cause of the
 * WhatsApp "stream conflict" / code 440 reconnect loop).
 * Now one row per workspace (id used to always be 1) — every workspace runs
 * its own independent Baileys socket, so each needs its own lock so that two
 * Autoscale instances never fight over the *same* workspace's session. This
 * does not limit how many different workspaces can connect concurrently.
 */
export const waInstanceLockTable = pgTable("wa_instance_lock", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  /** Opaque id identifying the process instance that currently holds the lock */
  holderId: text("holder_id").notNull(),
  heartbeatAt: timestamp("heartbeat_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wa_instance_lock_workspace_id_uniq").on(t.workspaceId),
]);
