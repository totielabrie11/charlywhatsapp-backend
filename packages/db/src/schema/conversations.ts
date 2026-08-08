import { pgTable, serial, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { workspacesTable } from "./tenancy";

export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  contactName: text("contact_name").notNull(),
  contactPhone: text("contact_phone").notNull(),
  contactAvatar: text("contact_avatar"),
  lastMessage: text("last_message").notNull().default(""),
  lastMessageAt: timestamp("last_message_at").notNull().defaultNow(),
  unreadCount: integer("unread_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  priority: text("priority"),
  clientId: integer("client_id").references(() => clientsTable.id),
  aiSummary: text("ai_summary"),
  whatsappJid: text("whatsapp_jid"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("conversations_phone_idx").on(t.contactPhone),
  index("conversations_status_idx").on(t.status),
  // 0.1: Added missing FK index — queries by clientId were doing full scans
  index("conversations_client_id_idx").on(t.clientId),
  index("conversations_last_message_at_idx").on(t.lastMessageAt),
  index("conversations_workspace_id_idx").on(t.workspaceId),
  // Each phone number is only unique *within* a workspace now — two
  // different users can both have a conversation with the same WhatsApp
  // number attached to their own independent session.
  uniqueIndex("conversations_workspace_phone_uniq").on(t.workspaceId, t.contactPhone),
]);

// Message delivery statuses (WhatsApp-style):
// "pending"  — saved locally, not yet sent to WhatsApp (disconnected queue)
// "sending"  — in-flight to Baileys
// "sent"     — Baileys accepted (single tick ✓)
// "failed"   — Baileys rejected after send attempt
export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id),
  content: text("content").notNull(),
  direction: text("direction").notNull(),
  mediaType: text("media_type").default("text"),
  mediaUrl: text("media_url"),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  isRead: boolean("is_read").notNull().default(false),
  aiGenerated: boolean("ai_generated").notNull().default(false),
  whatsappId: text("whatsapp_id"),
  status: text("status").notNull().default("sent"),
  // Fase 1: media support
  mediaData: text("media_data"),       // base64-encoded media (images, audio — capped at 5 MB)
  mediaName: text("media_name"),       // filename for documents
  mediaMimeType: text("media_mime_type"), // e.g. "image/jpeg", "audio/ogg", "application/pdf"
}, (t) => [
  index("messages_conversation_idx").on(t.conversationId),
  index("messages_status_idx").on(t.status),
  // 0.1: sentAt needed for chronological ordering in chat UI
  index("messages_sent_at_idx").on(t.sentAt),
  index("messages_workspace_id_idx").on(t.workspaceId),
  // Unique WhatsApp message ID prevents duplicate ingestion on reconnect.
  // We use a standard uniqueIndex — PostgreSQL automatically allows multiple
  // NULLs in a unique index (NULLs are considered distinct), so outbound
  // messages without a WA id yet don't conflict with each other or with inbound.
  uniqueIndex("messages_whatsapp_id_uniq").on(t.whatsappId),
]);

// Message reactions (WhatsApp-style emoji reactions on individual messages).
// One row per (message, sender_jid) pair; emoji="" means the reaction was removed.
// fromMe=true means this workspace's own account reacted.
export const messageReactionsTable = pgTable("message_reactions", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  messageId: integer("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull(),
  senderJid: text("sender_jid").notNull(),
  fromMe: boolean("from_me").notNull().default(false),
  reactedAt: timestamp("reacted_at").notNull().defaultNow(),
}, (t) => [
  index("message_reactions_message_idx").on(t.messageId),
  uniqueIndex("message_reactions_msg_sender_uniq").on(t.messageId, t.senderJid),
]);

export const insertConversationSchema = createInsertSchema(conversationsTable).omit({ id: true, createdAt: true });
export const insertMessageSchema = createInsertSchema(messagesTable).omit({ id: true });
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type MessageReaction = typeof messageReactionsTable.$inferSelect;
