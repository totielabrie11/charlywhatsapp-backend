import { Router } from "express";
import { db } from "@workspace/db";
import {
  aiSettingsTable,
  aiRolesTable,
  roleDocumentsTable,
  restrictionPoliciesTable,
  priorityPoliciesTable,
  documentsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { updateAutoReply } from "../services/whatsapp";
import { logger } from "../lib/logger";

const router = Router();

// ─── Helper ───────────────────────────────────────────────────────────────────

function roleJson(r: any) {
  return {
    ...r,
    specialties: r.specialties ?? [],
    createdAt: r.createdAt?.toISOString?.() ?? r.createdAt,
  };
}

// ─── AI Settings ─────────────────────────────────────────────────────────────

router.get("/settings/ai", async (req, res) => {
  const workspaceId = req.workspaceId!;
  let [settings] = await db.select().from(aiSettingsTable)
    .where(eq(aiSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (!settings) {
    [settings] = await db.insert(aiSettingsTable).values({ workspaceId }).returning();
  }
  res.json({
    primaryModel: settings.primaryModel,
    documentModel: settings.documentModel,
    fastModel: settings.fastModel,
    activeRoleId: settings.activeRoleId ?? null,
    autoReply: settings.autoReply,
    travelMode: settings.travelMode,
    agentMode: settings.agentMode ?? "manual",
    responseDelaySeconds: settings.responseDelaySeconds,
    unansweredDelaySeconds: settings.unansweredDelaySeconds ?? 0,
    waitingDelaySeconds: settings.waitingDelaySeconds ?? 0,
    securityRules: settings.securityRules,
    responseLength: settings.responseLength ?? "normal",
    formalityLevel: settings.formalityLevel ?? "comercial",
    useEmojis: settings.useEmojis ?? false,
    signature: settings.signature ?? null,
    maxWords: settings.maxWords ?? 0,
    catalogLines: settings.catalogLines ?? [],
    tagAutomation: {
      urgent: true, awaiting_quote: true, complaint: true, resolved: true,
      ...(settings.tagAutomation as Record<string, boolean> | null ?? {}),
    },
    iaEnabled: settings.iaEnabled ?? true,
    autoTaskEnabled: settings.autoTaskEnabled ?? true,
    autoPipelineEnabled: settings.autoPipelineEnabled ?? true,
    autoPipelineMinConfidence: settings.autoPipelineMinConfidence ?? "medium",
  });
});

router.patch("/settings/ai", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const body = req.body;
  let [settings] = await db.select().from(aiSettingsTable)
    .where(eq(aiSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (!settings) {
    [settings] = await db.insert(aiSettingsTable).values({ workspaceId }).returning();
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  const VALID_AGENT_MODES = ["manual", "solidario", "autonomo", "noche"] as const;
  if (body.agentMode !== undefined && !VALID_AGENT_MODES.includes(body.agentMode)) {
    res.status(400).json({ error: `agentMode must be one of: ${VALID_AGENT_MODES.join(", ")}` });
    return;
  }

  const allowed = [
    "primaryModel",
    "documentModel",
    "fastModel",
    "activeRoleId",
    "autoReply",
    "travelMode",
    "agentMode",
    "responseDelaySeconds",
    "unansweredDelaySeconds",
    "waitingDelaySeconds",
    "securityRules",
    "responseLength",
    "formalityLevel",
    "useEmojis",
    "signature",
    "maxWords",
    "catalogLines",
    "tagAutomation",
    "iaEnabled",
    "autoTaskEnabled",
    "autoPipelineEnabled",
    "autoPipelineMinConfidence",
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) update[key] = body[key];
  }
  if (body.tagAutomation !== undefined) {
    // Merge rather than replace, so patching one tag doesn't wipe the others.
    update.tagAutomation = {
      urgent: true, awaiting_quote: true, complaint: true, resolved: true,
      ...(settings.tagAutomation as Record<string, boolean> | null ?? {}),
      ...body.tagAutomation,
    };
  }

  const [updated] = await db
    .update(aiSettingsTable)
    .set(update)
    .where(and(eq(aiSettingsTable.id, settings.id), eq(aiSettingsTable.workspaceId, workspaceId)))
    .returning();

  if (body.autoReply !== undefined || body.travelMode !== undefined || body.agentMode !== undefined) {
    await updateAutoReply(body.autoReply, body.travelMode, body.agentMode).catch(e =>
      logger.warn({ err: e }, "Could not sync agentMode to WhatsApp state"),
    );
  }

  res.json({
    primaryModel: updated.primaryModel,
    documentModel: updated.documentModel,
    fastModel: updated.fastModel,
    activeRoleId: updated.activeRoleId ?? null,
    autoReply: updated.autoReply,
    travelMode: updated.travelMode,
    agentMode: updated.agentMode ?? "manual",
    responseDelaySeconds: updated.responseDelaySeconds,
    unansweredDelaySeconds: updated.unansweredDelaySeconds ?? 0,
    waitingDelaySeconds: updated.waitingDelaySeconds ?? 0,
    securityRules: updated.securityRules,
    responseLength: updated.responseLength ?? "normal",
    formalityLevel: updated.formalityLevel ?? "comercial",
    useEmojis: updated.useEmojis ?? false,
    signature: updated.signature ?? null,
    maxWords: updated.maxWords ?? 0,
    catalogLines: updated.catalogLines ?? [],
    tagAutomation: {
      urgent: true, awaiting_quote: true, complaint: true, resolved: true,
      ...(updated.tagAutomation as Record<string, boolean> | null ?? {}),
    },
    iaEnabled: updated.iaEnabled ?? true,
    autoTaskEnabled: updated.autoTaskEnabled ?? true,
    autoPipelineEnabled: updated.autoPipelineEnabled ?? true,
    autoPipelineMinConfidence: updated.autoPipelineMinConfidence ?? "medium",
  });
});

// ─── Roles ────────────────────────────────────────────────────────────────────

router.get("/settings/roles", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const roles = await db
    .select()
    .from(aiRolesTable)
    .where(eq(aiRolesTable.workspaceId, workspaceId))
    .orderBy(aiRolesTable.id);
  res.json(roles.map(roleJson));
});

router.post("/settings/roles", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const body = req.body;
  const [role] = await db
    .insert(aiRolesTable)
    .values({
      workspaceId,
      name: body.name || "Nuevo rol",
      description: body.description || "",
      personality: body.personality || "",
      specialties: body.specialties || [],
      active: body.active !== undefined ? body.active : true,
      isDefault: false,
    })
    .returning();
  res.status(201).json(roleJson(role));
});

router.patch("/settings/roles/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = req.body;
  const update: Record<string, unknown> = {};
  for (const key of ["name", "description", "personality", "specialties", "active"]) {
    if (body[key] !== undefined) update[key] = body[key];
  }

  const [role] = await db
    .update(aiRolesTable)
    .set(update)
    .where(and(eq(aiRolesTable.id, id), eq(aiRolesTable.workspaceId, workspaceId)))
    .returning();
  if (!role) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(roleJson(role));
});

/** Toggle active state — DOES NOT deactivate other roles (multi-active) */
router.post("/settings/roles/:id/toggle-active", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [role] = await db
    .select()
    .from(aiRolesTable)
    .where(and(eq(aiRolesTable.id, id), eq(aiRolesTable.workspaceId, workspaceId)))
    .limit(1);
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  // Guard: cannot deactivate the last active role
  if (role.active) {
    const allRoles = await db.select().from(aiRolesTable)
      .where(eq(aiRolesTable.workspaceId, workspaceId));
    const activeCount = allRoles.filter(r => r.active).length;
    if (activeCount <= 1) {
      res.status(409).json({
        error: "No se puede desactivar el último rol activo. Activá otro primero.",
      });
      return;
    }
  }

  await db
    .update(aiRolesTable)
    .set({ active: !role.active })
    .where(and(eq(aiRolesTable.id, id), eq(aiRolesTable.workspaceId, workspaceId)));

  const all = await db.select().from(aiRolesTable)
    .where(eq(aiRolesTable.workspaceId, workspaceId))
    .orderBy(aiRolesTable.id);
  res.json(all.map(roleJson));
});

/** Activate single role exclusively — kept for backward compat */
router.post("/settings/roles/:id/activate", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [role] = await db
    .select()
    .from(aiRolesTable)
    .where(and(eq(aiRolesTable.id, id), eq(aiRolesTable.workspaceId, workspaceId)))
    .limit(1);
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  // Exclusive activate — only within this workspace
  await db.update(aiRolesTable).set({ active: false })
    .where(eq(aiRolesTable.workspaceId, workspaceId));
  await db
    .update(aiRolesTable)
    .set({ active: true })
    .where(and(eq(aiRolesTable.id, id), eq(aiRolesTable.workspaceId, workspaceId)));

  // Sync settings
  let [settings] = await db.select().from(aiSettingsTable)
    .where(eq(aiSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (!settings) {
    [settings] = await db
      .insert(aiSettingsTable)
      .values({ workspaceId, activeRoleId: id })
      .returning();
  } else {
    await db
      .update(aiSettingsTable)
      .set({ activeRoleId: id, updatedAt: new Date() })
      .where(and(eq(aiSettingsTable.id, settings.id), eq(aiSettingsTable.workspaceId, workspaceId)));
  }

  const updated = await db
    .select()
    .from(aiRolesTable)
    .where(eq(aiRolesTable.workspaceId, workspaceId))
    .orderBy(aiRolesTable.id);
  res.json(updated.map(roleJson));
});

router.delete("/settings/roles/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(aiRolesTable)
    .where(and(eq(aiRolesTable.id, id), eq(aiRolesTable.workspaceId, workspaceId)));
  res.status(204).end();
});

// ─── Role Documents ────────────────────────────────────────────────────────────

router.get("/settings/roles/:id/documents", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const roleId = parseInt(req.params.id);
  if (isNaN(roleId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Verify role belongs to this workspace
  const [roleCheck] = await db.select({ id: aiRolesTable.id }).from(aiRolesTable)
    .where(and(eq(aiRolesTable.id, roleId), eq(aiRolesTable.workspaceId, workspaceId)));
  if (!roleCheck) { res.status(404).json({ error: "Role not found" }); return; }

  const rows = await db
    .select({
      id: roleDocumentsTable.id,
      documentId: documentsTable.id,
      name: documentsTable.name,
      type: documentsTable.type,
      size: documentsTable.size,
      description: documentsTable.description,
      createdAt: roleDocumentsTable.createdAt,
    })
    .from(roleDocumentsTable)
    .innerJoin(documentsTable, eq(roleDocumentsTable.documentId, documentsTable.id))
    .where(and(
      eq(roleDocumentsTable.roleId, roleId),
      eq(documentsTable.workspaceId, workspaceId),
    ));
  res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.post("/settings/roles/:id/documents", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const roleId = parseInt(req.params.id);
  if (isNaN(roleId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { documentId } = req.body;
  if (!documentId) {
    res.status(400).json({ error: "documentId required" });
    return;
  }

  const [role] = await db
    .select()
    .from(aiRolesTable)
    .where(and(eq(aiRolesTable.id, roleId), eq(aiRolesTable.workspaceId, workspaceId)))
    .limit(1);
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, documentId), eq(documentsTable.workspaceId, workspaceId)))
    .limit(1);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const existing = await db
    .select()
    .from(roleDocumentsTable)
    .where(and(eq(roleDocumentsTable.roleId, roleId), eq(roleDocumentsTable.documentId, documentId)))
    .limit(1);
  if (existing.length) {
    res.status(200).json({ id: existing[0].id, roleId, documentId, documentName: doc.name });
    return;
  }

  const [rd] = await db
    .insert(roleDocumentsTable)
    .values({ roleId, documentId })
    .returning();
  res.status(201).json({ id: rd.id, roleId, documentId, documentName: doc.name });
});

router.delete("/settings/roles/:id/documents/:docId", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const roleId = parseInt(req.params.id);
  const documentId = parseInt(req.params.docId);
  if (isNaN(roleId) || isNaN(documentId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Verify role belongs to this workspace
  const [roleCheck] = await db.select({ id: aiRolesTable.id }).from(aiRolesTable)
    .where(and(eq(aiRolesTable.id, roleId), eq(aiRolesTable.workspaceId, workspaceId)));
  if (!roleCheck) { res.status(404).json({ error: "Role not found" }); return; }

  await db
    .delete(roleDocumentsTable)
    .where(
      and(
        eq(roleDocumentsTable.roleId, roleId),
        eq(roleDocumentsTable.documentId, documentId),
      ),
    );
  res.status(204).end();
});

// ─── Catalog Policy ──────────────────────────────────────────────────────────

router.get("/settings/catalog-policy", async (req, res) => {
  const workspaceId = req.workspaceId!;
  let [settings] = await db.select().from(aiSettingsTable)
    .where(eq(aiSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (!settings) {
    [settings] = await db.insert(aiSettingsTable).values({ workspaceId }).returning();
  }
  res.json((settings as any).catalogPolicy ?? {});
});

router.patch("/settings/catalog-policy", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Body must be an object" });
    return;
  }
  let [settings] = await db.select().from(aiSettingsTable)
    .where(eq(aiSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (!settings) {
    [settings] = await db.insert(aiSettingsTable).values({ workspaceId }).returning();
  }
  const current = (settings as any).catalogPolicy ?? {};
  const merged = { ...current, ...body };
  await db
    .update(aiSettingsTable)
    .set({ catalogPolicy: merged, updatedAt: new Date() } as any)
    .where(and(eq(aiSettingsTable.id, settings.id), eq(aiSettingsTable.workspaceId, workspaceId)));
  res.json(merged);
});

// ─── Priority Policies ────────────────────────────────────────────────────────
// Positive mandatory instructions injected into every AI prompt.
// Examples: "Siempre pedir CUIT antes de cotizar", "Preguntar siempre el nombre completo".

router.get("/settings/priority-policies", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const policies = await db
    .select()
    .from(priorityPoliciesTable)
    .where(eq(priorityPoliciesTable.workspaceId, workspaceId))
    .orderBy(priorityPoliciesTable.id);
  res.json(policies.map(p => ({ ...p, createdAt: p.createdAt.toISOString() })));
});

router.post("/settings/priority-policies", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { rule, enabled } = req.body;
  if (typeof rule !== "string" || !rule.trim()) {
    res.status(400).json({ error: "rule must be a non-empty string" });
    return;
  }
  const [policy] = await db
    .insert(priorityPoliciesTable)
    .values({ workspaceId, rule: rule.trim(), enabled: enabled !== false })
    .returning();
  res.status(201).json({ ...policy, createdAt: policy.createdAt.toISOString() });
});

router.patch("/settings/priority-policies/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const update: Record<string, unknown> = {};
  if (req.body.rule !== undefined) {
    if (typeof req.body.rule !== "string" || !req.body.rule.trim()) {
      res.status(400).json({ error: "rule must be a non-empty string" }); return;
    }
    update.rule = req.body.rule.trim();
  }
  if (req.body.enabled !== undefined) update.enabled = req.body.enabled;
  const [policy] = await db
    .update(priorityPoliciesTable)
    .set(update)
    .where(and(eq(priorityPoliciesTable.id, id), eq(priorityPoliciesTable.workspaceId, workspaceId)))
    .returning();
  if (!policy) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...policy, createdAt: policy.createdAt.toISOString() });
});

router.delete("/settings/priority-policies/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(priorityPoliciesTable)
    .where(and(eq(priorityPoliciesTable.id, id), eq(priorityPoliciesTable.workspaceId, workspaceId)));
  res.status(204).end();
});

// ─── Restriction Policies ─────────────────────────────────────────────────────

router.get("/settings/policies", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const policies = await db
    .select()
    .from(restrictionPoliciesTable)
    .where(eq(restrictionPoliciesTable.workspaceId, workspaceId))
    .orderBy(restrictionPoliciesTable.id);
  res.json(policies.map(p => ({ ...p, createdAt: p.createdAt.toISOString() })));
});

router.post("/settings/policies", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { rule, enabled } = req.body;
  if (typeof rule !== "string" || !rule.trim()) {
    res.status(400).json({ error: "rule must be a non-empty string" });
    return;
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  const [policy] = await db
    .insert(restrictionPoliciesTable)
    .values({ workspaceId, rule: rule.trim(), enabled: enabled !== false })
    .returning();
  res.status(201).json({ ...policy, createdAt: policy.createdAt.toISOString() });
});

router.patch("/settings/policies/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const update: Record<string, unknown> = {};
  if (req.body.rule !== undefined) {
    if (typeof req.body.rule !== "string" || !req.body.rule.trim()) {
      res.status(400).json({ error: "rule must be a non-empty string" });
      return;
    }
    update.rule = req.body.rule.trim();
  }
  if (req.body.enabled !== undefined) {
    if (typeof req.body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    update.enabled = req.body.enabled;
  }

  const [policy] = await db
    .update(restrictionPoliciesTable)
    .set(update)
    .where(and(eq(restrictionPoliciesTable.id, id), eq(restrictionPoliciesTable.workspaceId, workspaceId)))
    .returning();
  if (!policy) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ...policy, createdAt: policy.createdAt.toISOString() });
});

router.delete("/settings/policies/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .delete(restrictionPoliciesTable)
    .where(and(eq(restrictionPoliciesTable.id, id), eq(restrictionPoliciesTable.workspaceId, workspaceId)));
  res.status(204).end();
});

export default router;
