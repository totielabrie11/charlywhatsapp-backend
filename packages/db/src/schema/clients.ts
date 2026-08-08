import { pgTable, serial, text, timestamp, real, boolean, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workspacesTable } from "./tenancy";

export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  company: text("company"),
  phone: text("phone").notNull(),
  email: text("email"),
  province: text("province"),
  city: text("city"),
  country: text("country").default("Argentina"),
  address: text("address"),
  position: text("position"),
  industry: text("industry"),
  cuit: text("cuit"),
  website: text("website"),
  priority: text("priority").notNull().default("B"),
  stage: text("stage").notNull().default("prospect"),
  tags: text("tags").array().default([]),
  estimatedBilling: real("estimated_billing"),
  totalSales: real("total_sales").notNull().default(0),
  purchasedProducts: text("purchased_products").array().default([]),
  consultedProducts: text("consulted_products").array().default([]),
  notes: text("notes"),
  lastContactAt: timestamp("last_contact_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ── Google Contacts CSV import (decoupled, manual/offline sync only — see
  // services/googleContactsImport.ts) — these never affect existing queries
  // or filters above; they only get populated when a client comes from an
  // imported Google Contacts row. ──
  googleContactId: text("google_contact_id"),
  lastGoogleSync: timestamp("last_google_sync"),
  syncStatus: text("sync_status"),
  isGoogleContact: boolean("is_google_contact").notNull().default(false),
  // ── WhatsApp CRM Sync ─────────────────────────────────────────────────────
  profilePicUrl: text("profile_pic_url"),       // latest WA profile photo URL
  waDisplayName: text("wa_display_name"),       // last known WA push name
  nameLocked: boolean("name_locked").notNull().default(false), // future: prevent auto-name overwrite
  lastSyncAt: timestamp("last_sync_at"),        // timestamp of last CRM sync
}, (t) => [
  index("clients_phone_idx").on(t.phone),
  index("clients_priority_idx").on(t.priority),
  index("clients_workspace_id_idx").on(t.workspaceId),
]);

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, createdAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
