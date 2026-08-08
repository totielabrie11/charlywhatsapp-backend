/**
 * AI Provider Config routes — CRUD for the "Configurar IA" settings tab.
 *
 * GET  /settings/ai-provider         → current config (no raw API key returned)
 * POST /settings/ai-provider         → save / update config
 * POST /settings/ai-provider/verify  → test connection with given params
 * DELETE /settings/ai-provider       → remove config (fall back to env var)
 * GET  /settings/ai-provider/status  → runtime status for Monitor tab
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  loadProviderConfig,
  invalidateProviderCache,
  verifyAIProvider,
  getAIProviderStatus,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_BASE_URLS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_PRESETS,
  type ProviderName,
} from "../services/aiProvider";

const router = Router();

const VALID_PROVIDERS: ProviderName[] = ["groq", "openai", "anthropic", "openrouter"];

// ── GET /settings/ai-provider ─────────────────────────────────────────────────

router.get("/settings/ai-provider", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const { aiProviderConfigTable } = await import("@workspace/db");
    const [cfg] = await db
      .select()
      .from(aiProviderConfigTable)
      .where(eq(aiProviderConfigTable.workspaceId, workspaceId))
      .limit(1);

    // Never return the raw API key — only the last 4 chars for display
    const apiKeyMasked = cfg?.apiKey
      ? (cfg.apiKey.length > 8 ? "****" + cfg.apiKey.slice(-4) : "****")
      : null;

    res.json({
      configured: !!cfg?.apiKey,
      provider: cfg?.provider ?? "groq",
      model: cfg?.model ?? PROVIDER_DEFAULT_MODELS["groq"].chat,
      visionModel: cfg?.visionModel ?? PROVIDER_DEFAULT_MODELS["groq"].vision,
      apiKeyMasked,
      lastVerifiedAt: cfg?.lastVerifiedAt ?? null,
      lastVerifyMs: cfg?.lastVerifyMs ?? null,
      lastVerifyOk: cfg?.lastVerifyOk ?? null,
      lastVerifyError: cfg?.lastVerifyError ?? null,
      // Metadata for UI
      providers: VALID_PROVIDERS.map(p => ({
        id: p,
        label: PROVIDER_LABELS[p],
        baseUrl: PROVIDER_BASE_URLS[p],
        defaultModel: PROVIDER_DEFAULT_MODELS[p].chat,
        defaultVisionModel: PROVIDER_DEFAULT_MODELS[p].vision,
        modelPresets: PROVIDER_MODEL_PRESETS[p],
      })),
    });
  } catch (e: any) {
    logger.error({ err: e }, "GET /settings/ai-provider failed");
    res.status(500).json({ error: "Error al obtener configuración" });
  }
});

// ── POST /settings/ai-provider ────────────────────────────────────────────────

router.post("/settings/ai-provider", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { provider, apiKey, model, visionModel } = req.body ?? {};

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    return;
  }
  const prov = provider as ProviderName;
  const chatModel = model ?? PROVIDER_DEFAULT_MODELS[prov].chat;
  const vModel = visionModel ?? PROVIDER_DEFAULT_MODELS[prov].vision;

  try {
    const { aiProviderConfigTable } = await import("@workspace/db");
    // Fetch existing config first — apiKey is optional on updates (reuse stored key)
    const [existing] = await db
      .select()
      .from(aiProviderConfigTable)
      .where(eq(aiProviderConfigTable.workspaceId, workspaceId))
      .limit(1);

    // Resolve the key to use: new key if provided, existing stored key if not, error if neither
    const newKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const cleanKey = newKey.length >= 8 ? newKey : (existing?.apiKey ?? "");
    if (!cleanKey || cleanKey.length < 8) {
      res.status(400).json({ error: "apiKey es requerida (mínimo 8 caracteres)" });
      return;
    }

    if (existing) {
      await db
        .update(aiProviderConfigTable)
        .set({ provider: prov, apiKey: cleanKey, model: chatModel, visionModel: vModel, updatedAt: new Date() })
        .where(eq(aiProviderConfigTable.workspaceId, workspaceId));
    } else {
      await db.insert(aiProviderConfigTable).values({
        workspaceId,
        provider: prov,
        apiKey: cleanKey,
        model: chatModel,
        visionModel: vModel,
      });
    }

    // Auto-verify immediately after saving — this sets lastVerifyOk so AI is enabled
    const verifyResult = await verifyAIProvider(prov, cleanKey, chatModel);

    // Persist verification result
    await db
      .update(aiProviderConfigTable)
      .set({
        lastVerifyOk: verifyResult.ok,
        lastVerifyMs: verifyResult.ms,
        lastVerifyError: verifyResult.error ?? null,
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiProviderConfigTable.workspaceId, workspaceId));

    // Reload cache with verified state
    invalidateProviderCache(workspaceId);
    await loadProviderConfig(workspaceId);

    logger.info({ workspaceId, provider: prov, model: chatModel, verifyOk: verifyResult.ok }, "[AIProvider] Config saved and auto-verified");
    res.json({ ok: true, provider: prov, model: chatModel, verifyResult });
  } catch (e: any) {
    logger.error({ err: e }, "POST /settings/ai-provider failed");
    res.status(500).json({ error: "Error al guardar configuración" });
  }
});

// ── POST /settings/ai-provider/verify ─────────────────────────────────────────

router.post("/settings/ai-provider/verify", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { provider, apiKey, model } = req.body ?? {};

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: "provider inválido" });
    return;
  }

  const prov = provider as ProviderName;
  const chatModel = model ?? PROVIDER_DEFAULT_MODELS[prov].chat;

  try {
    // Resolve key: use provided key, fall back to stored key in DB
    let keyToVerify = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!keyToVerify) {
      const { aiProviderConfigTable } = await import("@workspace/db");
      const [cfg] = await db
        .select({ apiKey: aiProviderConfigTable.apiKey })
        .from(aiProviderConfigTable)
        .where(eq(aiProviderConfigTable.workspaceId, workspaceId))
        .limit(1);
      if (!cfg?.apiKey) {
        res.status(400).json({ error: "No hay API Key guardada. Ingresá una para verificar." });
        return;
      }
      keyToVerify = cfg.apiKey;
    }
    const result = await verifyAIProvider(prov, keyToVerify, chatModel);

    // Persist verify result to DB if this is the saved provider
    try {
      const { aiProviderConfigTable } = await import("@workspace/db");
      await db
        .update(aiProviderConfigTable)
        .set({
          lastVerifiedAt: new Date(),
          lastVerifyMs: result.ms,
          lastVerifyOk: result.ok,
          lastVerifyError: result.error ?? null,
          updatedAt: new Date(),
        })
        .where(eq(aiProviderConfigTable.workspaceId, workspaceId));
    } catch {
      // Non-critical — don't fail the verify response
    }

    res.json(result);
  } catch (e: any) {
    res.json({ ok: false, ms: 0, error: e?.message ?? "Error desconocido" });
  }
});

// ── DELETE /settings/ai-provider ─────────────────────────────────────────────

router.delete("/settings/ai-provider", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const { aiProviderConfigTable } = await import("@workspace/db");
    await db.delete(aiProviderConfigTable).where(eq(aiProviderConfigTable.workspaceId, workspaceId));
    invalidateProviderCache(workspaceId);
    logger.info({ workspaceId }, "[AIProvider] Config deleted");
    res.status(204).end();
  } catch (e: any) {
    logger.error({ err: e }, "DELETE /settings/ai-provider failed");
    res.status(500).json({ error: "Error al eliminar configuración" });
  }
});

// ── GET /settings/ai-provider/status ─────────────────────────────────────────

router.get("/settings/ai-provider/status", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const { aiProviderConfigTable } = await import("@workspace/db");
    const [cfg] = await db
      .select()
      .from(aiProviderConfigTable)
      .where(eq(aiProviderConfigTable.workspaceId, workspaceId))
      .limit(1);

    const runtimeStatus = getAIProviderStatus(workspaceId);

    res.json({
      ...runtimeStatus,
      lastVerifiedAt: cfg?.lastVerifiedAt ?? null,
      lastVerifyMs: cfg?.lastVerifyMs ?? null,
      lastVerifyOk: cfg?.lastVerifyOk ?? null,
      lastVerifyError: cfg?.lastVerifyError ?? null,
    });
  } catch (e: any) {
    const runtimeStatus = getAIProviderStatus(workspaceId);
    res.json({ ...runtimeStatus, lastVerifiedAt: null, lastVerifyMs: null, lastVerifyOk: null, lastVerifyError: null });
  }
});

export default router;
