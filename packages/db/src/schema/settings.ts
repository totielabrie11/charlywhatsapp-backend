import { pgTable, serial, text, timestamp, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentsTable } from "./documents";
import { workspacesTable } from "./tenancy";

export const aiSettingsTable = pgTable("ai_settings", {
  id: serial("id").primaryKey(),
  // One settings row per workspace (was a single global row). Nullable only
  // until the backfill migration assigns every existing row to a workspace.
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  primaryModel: text("primary_model").notNull().default("openai"),
  documentModel: text("document_model").notNull().default("openai"),
  fastModel: text("fast_model").notNull().default("openai"),
  /** Kept for backward compat; multi-active is via aiRolesTable.active */
  activeRoleId: integer("active_role_id"),
  autoReply: boolean("auto_reply").notNull().default(false),
  travelMode: boolean("travel_mode").notNull().default(false),
  /**
   * Agent mode controls when AI responds automatically.
   * 'manual'   — AI only suggests, operator decides.
   * 'solidario'— AI auto-sends using responseDelaySeconds window.
   * 'autonomo' — AI auto-sends immediately.
   * 'noche'    — Autónomo only outside business hours (18:00–09:00).
   */
  agentMode: text("agent_mode").notNull().default("manual"),
  responseDelaySeconds: integer("response_delay_seconds").notNull().default(3),
  /**
   * Per-tag on/off switch for the rule-based (keyword) classifiers in
   * services/ai.ts. This is independent of `agentMode` — agentMode only
   * gates automatic AI *replies*; these flags control whether inbound
   * messages get auto-tagged/auto-task-created at all for each label.
   * Default true for all so existing behavior (e.g. "urgente") is unchanged
   * until an operator explicitly turns a tag off.
   */
  tagAutomation: jsonb("tag_automation").notNull().default({
    urgent: true,
    awaiting_quote: true,
    complaint: true,
    resolved: true,
  }),
  /** Seconds to wait before auto-tagging a conversation as "sin respuesta" (0 = immediate) */
  unansweredDelaySeconds: integer("unanswered_delay_seconds").notNull().default(0),
  /** Seconds to wait before auto-tagging an inbound conversation as "en espera" (0 = immediate) */
  waitingDelaySeconds: integer("waiting_delay_seconds").notNull().default(0),
  /**
   * Master IA switch. When false, ALL automatic AI actions are disabled:
   * auto-tags (keyword classifiers), auto-tasks, and auto-pipeline creation.
   * En espera / Sin respuesta timers still work (they're timer-based, not AI).
   * Default true so existing installs are unaffected.
   */
  iaEnabled: boolean("ia_enabled").notNull().default(true),
  /**
   * Controls whether the AI automatically creates tasks when it detects
   * urgent, quote, purchase, complaint or support intents in inbound messages.
   * Requires iaEnabled = true to have any effect.
   */
  autoTaskEnabled: boolean("auto_task_enabled").notNull().default(true),
  /**
   * Controls whether the AI automatically creates/updates Pipeline opportunities
   * when it detects commercial signals in messages (inbound or outbound).
   * Requires iaEnabled = true to have any effect.
   */
  autoPipelineEnabled: boolean("auto_pipeline_enabled").notNull().default(true),
  /**
   * Minimum confidence level for auto-pipeline creation.
   * 'medium' — creates on medium or high confidence (default, more sensitive).
   * 'high'   — only creates on clearly high-confidence signals (fewer false positives).
   */
  autoPipelineMinConfidence: text("auto_pipeline_min_confidence").notNull().default("medium"),
  securityRules: jsonb("security_rules").notNull().default({
    neverSendPriceIfNotInList: true,
    neverPromiseDelivery: true,
    neverInventData: true,
    askForConfirmation: true,
  }),
  /** Controls which technical fields are shown in motor catalog responses */
  catalogPolicy: jsonb("catalog_policy").notNull().default({
    detailLevel: "standard",
    showFrame: true,
    showRpm: true,
    showCurrent: true,
    showPowerFactor: false,
    showEfficiency: true,
    showWeight: false,
    showMounting: false,
    showOrderCode: false,
    showTension: false,
    showBearings: false,
    showShaftDiameter: false,
  }),
  // ── Response style (Fase 1.0 roadmap features 3-10) ────────────────────────
  /** Response length: muy_breve | breve | normal | detallada | tecnica */
  responseLength: text("response_length").notNull().default("normal"),
  /** Formality: muy_formal | comercial | cercano | tecnico | ejecutivo */
  formalityLevel: text("formality_level").notNull().default("comercial"),
  /** Whether the AI should use emojis */
  useEmojis: boolean("use_emojis").notNull().default(false),
  /** Optional auto-signature appended to every AI response */
  signature: text("signature"),
  /** Max words (0 = no limit) */
  maxWords: integer("max_words").notNull().default(0),
  /** Enabled product/catalog lines — array of {name, enabled} */
  catalogLines: jsonb("catalog_lines").notNull().default([
    { name: "Motores IE1", enabled: true },
    { name: "Motores IE2", enabled: true },
    { name: "Motores IE3", enabled: true },
    { name: "Motores IE4", enabled: false },
    { name: "Motores IE5", enabled: false },
    { name: "Motores antiexplosivos", enabled: false },
    { name: "Motores freno", enabled: false },
    { name: "Motores inoxidables", enabled: false },
    { name: "Motores marinos", enabled: false },
    { name: "Motores monofásicos", enabled: true },
    { name: "Motores trifásicos", enabled: true },
    { name: "Variadores de frecuencia", enabled: false },
    { name: "Bombas", enabled: false },
    { name: "Reductores", enabled: false },
  ]),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_settings_workspace_id_uniq").on(t.workspaceId),
]);

export const aiRolesTable = pgTable("ai_roles", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  personality: text("personality").notNull(),
  specialties: text("specialties").array().default([]),
  /** When true this role participates in generating AI prompts (multi-active supported) */
  active: boolean("active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ai_roles_workspace_id_idx").on(t.workspaceId),
]);

/**
 * Per-workspace AI provider configuration.
 * Stores the active provider (Groq, OpenAI, Anthropic, OpenRouter),
 * the API key, model name, and last verification result.
 * All AI calls in the app route through services/aiProvider.ts which reads this table.
 */
export const aiProviderConfigTable = pgTable("ai_provider_config", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id).unique(),
  provider: text("provider").notNull().default("groq"),
  apiKey: text("api_key"),
  model: text("model").notNull().default("llama-3.3-70b-versatile"),
  visionModel: text("vision_model").notNull().default("meta-llama/llama-4-scout-17b-16e-instruct"),
  lastVerifiedAt: timestamp("last_verified_at"),
  lastVerifyMs: integer("last_verify_ms"),
  lastVerifyOk: boolean("last_verify_ok"),
  lastVerifyError: text("last_verify_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Join table: documents assigned to a specific AI role for context */
export const roleDocumentsTable = pgTable("role_documents", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull().references(() => aiRolesTable.id, { onDelete: "cascade" }),
  documentId: integer("document_id").notNull().references(() => documentsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** User-configurable restriction rules injected as hard constraints into every AI prompt */
export const restrictionPoliciesTable = pgTable("restriction_policies", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  rule: text("rule").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("restriction_policies_workspace_id_idx").on(t.workspaceId),
]);

/**
 * Priority policies — mandatory questions/actions the AI must include in every response.
 * Examples: "Siempre pedir CUIT antes de cotizar", "Siempre confirmar el nombre completo".
 * These are injected as positive instructions, not restrictions.
 */
export const priorityPoliciesTable = pgTable("priority_policies", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspacesTable.id),
  rule: text("rule").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("priority_policies_workspace_id_idx").on(t.workspaceId),
]);

export const insertAiSettingsSchema = createInsertSchema(aiSettingsTable).omit({ id: true, updatedAt: true });
export const insertAiRoleSchema = createInsertSchema(aiRolesTable).omit({ id: true, createdAt: true });
export const insertRoleDocumentSchema = createInsertSchema(roleDocumentsTable).omit({ id: true, createdAt: true });
export const insertRestrictionPolicySchema = createInsertSchema(restrictionPoliciesTable).omit({ id: true, createdAt: true });
export const insertPriorityPolicySchema = createInsertSchema(priorityPoliciesTable).omit({ id: true, createdAt: true });

export type AiProviderConfig = typeof aiProviderConfigTable.$inferSelect;

export type InsertAiSettings = z.infer<typeof insertAiSettingsSchema>;
export type InsertAiRole = z.infer<typeof insertAiRoleSchema>;
export type InsertRoleDocument = z.infer<typeof insertRoleDocumentSchema>;
export type InsertRestrictionPolicy = z.infer<typeof insertRestrictionPolicySchema>;
export type InsertPriorityPolicy = z.infer<typeof insertPriorityPolicySchema>;
export type AiSettings = typeof aiSettingsTable.$inferSelect;
export type AiRole = typeof aiRolesTable.$inferSelect;
export type RoleDocument = typeof roleDocumentsTable.$inferSelect;
export type RestrictionPolicy = typeof restrictionPoliciesTable.$inferSelect;
export type PriorityPolicy = typeof priorityPoliciesTable.$inferSelect;
