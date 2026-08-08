/**
 * AI Provider Manager — single point of control for all AI calls in CharlyWhatsapp.
 *
 * Rules:
 *  - All AI calls must go through getAIClient() / getAIModel() / getVisionModel().
 *  - Never use Replit internal AI for business logic.
 *  - If the workspace has a configured provider in DB → use it.
 *  - Otherwise → fall back to GROQ_API_KEY env var (backward compat).
 *  - If neither exists → throw an explicit error (no silent fallback).
 *
 * Config is loaded at server startup via loadAllProviderConfigs() and updated
 * synchronously when the API route saves new settings (invalidateProviderCache +
 * loadProviderConfig).
 */

import OpenAI from "openai";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── BYO AI enforcement ─────────────────────────────────────────────────────────

/**
 * Thrown whenever an AI function is called but no verified provider is configured.
 * Callers must catch this and either:
 *   - Return null / skip (automatic functions — no user-visible error)
 *   - Return AI_DISCONNECTED_MESSAGE (manual / user-facing functions)
 */
export class AINotConfiguredError extends Error {
  constructor(public readonly reason: string, public readonly module?: string) {
    super(`IA desconectada: ${reason}`);
    this.name = "AINotConfiguredError";
  }
}

/** Standard user-facing message returned by manual AI functions when no provider is configured. */
export const AI_DISCONNECTED_MESSAGE =
  "IA desconectada. Configure un proveedor de IA para habilitar esta función.";

// ── Provider definitions ───────────────────────────────────────────────────────

export type ProviderName = "groq" | "openai" | "anthropic" | "openrouter";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  groq: "Groq",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  openrouter: "OpenRouter",
};

export const PROVIDER_BASE_URLS: Record<ProviderName, string> = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export const PROVIDER_DEFAULT_MODELS: Record<ProviderName, { chat: string; vision: string }> = {
  groq: {
    chat: "llama-3.3-70b-versatile",
    vision: "meta-llama/llama-4-scout-17b-16e-instruct",
  },
  openai: { chat: "gpt-4o", vision: "gpt-4o" },
  anthropic: { chat: "claude-3-5-sonnet-20241022", vision: "claude-3-5-sonnet-20241022" },
  openrouter: {
    chat: "meta-llama/llama-3.3-70b-instruct",
    vision: "meta-llama/llama-3.3-70b-instruct",
  },
};

// Preset model lists shown in the UI
export const PROVIDER_MODEL_PRESETS: Record<ProviderName, string[]> = {
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama-3.1-70b-versatile",
    "gemma2-9b-it",
    "mixtral-8x7b-32768",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  anthropic: [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ],
  openrouter: [
    "meta-llama/llama-3.3-70b-instruct",
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o",
    "mistralai/mistral-7b-instruct",
  ],
};

// ── In-memory cache ────────────────────────────────────────────────────────────

interface ProviderEntry {
  client: OpenAI;
  model: string;
  visionModel: string;
  provider: ProviderName;
  apiKeyMasked: string; // last 4 chars, for display
  /** true only when lastVerifyOk === true in DB — AI calls are blocked until verified */
  verified: boolean;
}

// workspaceId → ProviderEntry
const _cache = new Map<number, ProviderEntry>();

// No env-var fallback client — BYO AI mode requires explicit configuration + verification.

function buildProviderClient(provider: ProviderName, apiKey: string): OpenAI {
  const clean = apiKey.replace(/[^\x20-\x7E]/g, "").trim();
  return new OpenAI({ apiKey: clean, baseURL: PROVIDER_BASE_URLS[provider] });
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return "****" + key.slice(-4);
}

// ── Cache management ───────────────────────────────────────────────────────────

/** Load provider config for one workspace from DB and update cache. */
export async function loadProviderConfig(workspaceId: number): Promise<void> {
  try {
    const { aiProviderConfigTable } = await import("@workspace/db");
    const [cfg] = await db
      .select()
      .from(aiProviderConfigTable)
      .where(eq(aiProviderConfigTable.workspaceId, workspaceId))
      .limit(1);

    if (cfg?.apiKey) {
      const provider = (cfg.provider ?? "groq") as ProviderName;
      _cache.set(workspaceId, {
        client: buildProviderClient(provider, cfg.apiKey),
        model: cfg.model ?? PROVIDER_DEFAULT_MODELS[provider].chat,
        visionModel: cfg.visionModel ?? PROVIDER_DEFAULT_MODELS[provider].vision,
        provider,
        apiKeyMasked: maskKey(cfg.apiKey),
        verified: cfg.lastVerifyOk === true,
      });
    } else {
      _cache.delete(workspaceId);
    }
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "[AIProvider] Failed to load provider config");
  }
}

/** Called at server startup — warms the cache for every configured workspace. */
export async function loadAllProviderConfigs(): Promise<void> {
  try {
    const { aiProviderConfigTable } = await import("@workspace/db");
    const configs = await db.select().from(aiProviderConfigTable);
    let loaded = 0;
    for (const cfg of configs) {
      if (cfg.apiKey) {
        const provider = (cfg.provider ?? "groq") as ProviderName;
        _cache.set(cfg.workspaceId, {
          client: buildProviderClient(provider, cfg.apiKey),
          model: cfg.model ?? PROVIDER_DEFAULT_MODELS[provider].chat,
          visionModel: cfg.visionModel ?? PROVIDER_DEFAULT_MODELS[provider].vision,
          provider,
          apiKeyMasked: maskKey(cfg.apiKey),
          verified: cfg.lastVerifyOk === true,
        });
        loaded++;
      }
    }
    logger.info({ loaded }, "[AIProvider] Provider configs loaded at startup");
  } catch (e) {
    logger.warn({ err: e }, "[AIProvider] Failed to load provider configs at startup");
  }
}

/** Invalidate a workspace's cached client (call after config save/delete). */
export function invalidateProviderCache(workspaceId: number): void {
  _cache.delete(workspaceId);
}

// ── Public accessors ───────────────────────────────────────────────────────────

/**
 * Returns the configured AI client for a workspace.
 * Throws AINotConfiguredError if no provider is configured AND verified.
 * Callers must catch and handle: return null (auto) or AI_DISCONNECTED_MESSAGE (manual).
 */
export function getAIClient(workspaceId?: number, callerModule = "unknown"): OpenAI {
  if (workspaceId !== undefined) {
    const cached = _cache.get(workspaceId);
    if (cached) {
      if (!cached.verified) {
        logAIBlocked(callerModule, `Proveedor configurado (${cached.provider}) pero sin verificar`, workspaceId);
        throw new AINotConfiguredError(`Proveedor ${cached.provider} configurado pero sin verificar`, callerModule);
      }
      return cached.client;
    }
  }
  // Single-tenant fallback: use first verified workspace
  for (const [wsId, entry] of _cache.entries()) {
    if (entry.verified) return entry.client;
  }
  // No configured+verified provider anywhere
  logAIBlocked(callerModule, "Sin proveedor de IA configurado y verificado", workspaceId);
  throw new AINotConfiguredError("Sin proveedor de IA configurado y verificado. Configurá uno en Ajustes → Configurar IA.", callerModule);
}

// ── Readiness API ──────────────────────────────────────────────────────────────

/**
 * Synchronous readiness check — does NOT throw. Use this for gates.
 * Returns { ready: true } only when a provider is configured AND verified.
 */
export function isAIReady(workspaceId?: number): { ready: boolean; reason?: string } {
  if (workspaceId !== undefined) {
    const cached = _cache.get(workspaceId);
    if (!cached) return { ready: false, reason: "Sin proveedor de IA configurado" };
    if (!cached.verified) return { ready: false, reason: `Proveedor ${cached.provider} configurado pero sin verificar` };
    return { ready: true };
  }
  for (const entry of _cache.values()) {
    if (entry.verified) return { ready: true };
  }
  return { ready: false, reason: "Sin proveedor de IA configurado y verificado" };
}

/** Audit log entry for blocked AI calls. */
export function logAIBlocked(module: string, reason: string, workspaceId?: number): void {
  logger.info({ module, reason, workspaceId }, "[AIProvider] AI call blocked — no verified provider");
}

/**
 * Returns the configured chat model string for a workspace.
 * Falls back to Groq default if not configured.
 */
export function getAIModel(workspaceId?: number): string {
  if (workspaceId !== undefined) {
    const cached = _cache.get(workspaceId);
    if (cached) return cached.model;
  }
  if (_cache.size > 0) return _cache.values().next().value!.model;
  return PROVIDER_DEFAULT_MODELS.groq.chat;
}

/**
 * Returns the configured vision/multimodal model string for a workspace.
 */
export function getVisionModel(workspaceId?: number): string {
  if (workspaceId !== undefined) {
    const cached = _cache.get(workspaceId);
    if (cached) return cached.visionModel;
  }
  if (_cache.size > 0) return _cache.values().next().value!.visionModel;
  return PROVIDER_DEFAULT_MODELS.groq.vision;
}

/** Returns the active provider name for a workspace. */
export function getProviderName(workspaceId?: number): ProviderName {
  if (workspaceId !== undefined) {
    const cached = _cache.get(workspaceId);
    if (cached) return cached.provider;
  }
  for (const entry of _cache.values()) return entry.provider;
  return "groq";
}

/** Returns status info for the Monitor tab and Configurar IA tab. */
export function getAIProviderStatus(workspaceId?: number): {
  configured: boolean;
  verified: boolean;
  provider: ProviderName;
  model: string;
  apiKeyMasked: string;
} {
  const entry = workspaceId !== undefined
    ? _cache.get(workspaceId)
    : ((): ProviderEntry | undefined => { for (const e of _cache.values()) return e; return undefined; })();

  if (entry) {
    return {
      configured: true,
      verified: entry.verified,
      provider: entry.provider,
      model: entry.model,
      apiKeyMasked: entry.apiKeyMasked,
    };
  }
  return {
    configured: false,
    verified: false,
    provider: "groq",
    model: PROVIDER_DEFAULT_MODELS.groq.chat,
    apiKeyMasked: "no configurada",
  };
}

// ── Verification ───────────────────────────────────────────────────────────────

/**
 * Tests a provider/key/model combination by making a minimal completions call.
 * Returns latency in ms and any error message.
 */
export async function verifyAIProvider(
  provider: ProviderName,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const client = buildProviderClient(provider, apiKey);
    await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Respondé solo: ok" }],
      max_tokens: 5,
    });
    return { ok: true, ms: Date.now() - start };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return { ok: false, ms: Date.now() - start, error: msg };
  }
}
