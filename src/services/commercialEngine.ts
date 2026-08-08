/**
 * Commercial Intelligence Engine (CIE)
 *
 * Builds on top of the existing clientProfiles.ts computation:
 * 1. Runs the existing rule-based engine (preserves commercialScore exact formula)
 * 2. Loads workspace-configurable keywords from DB and scores keyword occurrences
 * 3. Derives enginePriority and engineStage from configurable thresholds
 * 4. Returns a full explainability breakdown (which keywords fired, how many points each)
 *
 * The "Sincronizar Estado Comercial" button is the ONLY thing that writes back
 * client.priority and client.stage — the plain compute-profile endpoint does NOT.
 */

import { db } from "@workspace/db";
import {
  clientsTable,
  clientProfilesTable,
  conversationsTable,
  messagesTable,
  commercialKeywordsTable,
  commercialRulesTable,
} from "@workspace/db";
import type { AppliedRule } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { computeClientProfile } from "./clientProfiles";

// ─── Default thresholds (used when workspace has no custom rules) ─────────────

export const DEFAULT_PRIORITY_RULES = [
  { minScore: 81, maxScore: 100, value: "A" },
  { minScore: 61, maxScore: 80,  value: "B" },
  { minScore: 41, maxScore: 60,  value: "C" },
  { minScore: 21, maxScore: 40,  value: "D" },
  { minScore: 0,  maxScore: 20,  value: "E" },
];

export const DEFAULT_STAGE_RULES = [
  { minScore: 86, maxScore: 100, value: "cliente_frecuente" },
  { minScore: 71, maxScore: 85,  value: "cliente_activo" },
  { minScore: 56, maxScore: 70,  value: "negociacion" },
  { minScore: 41, maxScore: 55,  value: "cotizacion" },
  { minScore: 26, maxScore: 40,  value: "consulta" },
  { minScore: 11, maxScore: 25,  value: "contacto" },
  { minScore: 0,  maxScore: 10,  value: "prospecto" },
];

// ─── Default seed keywords (mirrors INTEREST_MAP from clientProfiles.ts) ──────
// Shown in settings when workspace hasn't customised anything yet.
export const DEFAULT_SEED_KEYWORDS: Array<{
  keyword: string;
  weight: number;
  category: string;
}> = [
  // Cotización / Precio — alta intención comercial
  { keyword: "cotización",    weight: 15, category: "Cotización / Precio" },
  { keyword: "cotizacion",    weight: 15, category: "Cotización / Precio" },
  { keyword: "cotizar",       weight: 12, category: "Cotización / Precio" },
  { keyword: "presupuesto",   weight: 12, category: "Cotización / Precio" },
  { keyword: "precio",        weight: 8,  category: "Cotización / Precio" },
  { keyword: "cuánto",        weight: 6,  category: "Cotización / Precio" },
  { keyword: "costo",         weight: 6,  category: "Cotización / Precio" },
  { keyword: "oferta",        weight: 5,  category: "Cotización / Precio" },
  { keyword: "stock",         weight: 5,  category: "Cotización / Precio" },
  // Motores
  { keyword: "motor",         weight: 8,  category: "Motores Eléctricos" },
  { keyword: "motores",       weight: 8,  category: "Motores Eléctricos" },
  { keyword: "IE1",           weight: 6,  category: "Motores Eléctricos" },
  { keyword: "IE2",           weight: 6,  category: "Motores Eléctricos" },
  { keyword: "IE3",           weight: 6,  category: "Motores Eléctricos" },
  { keyword: "ABB",           weight: 5,  category: "Motores Eléctricos" },
  { keyword: "WEG",           weight: 5,  category: "Motores Eléctricos" },
  { keyword: "Siemens",       weight: 5,  category: "Motores Eléctricos" },
  { keyword: "simotics",      weight: 5,  category: "Motores Eléctricos" },
  // Bombas
  { keyword: "bomba",         weight: 8,  category: "Bombas y Fluidos" },
  { keyword: "bombas",        weight: 8,  category: "Bombas y Fluidos" },
  // Variadores
  { keyword: "variador",      weight: 8,  category: "Variadores" },
  { keyword: "drive",         weight: 5,  category: "Variadores" },
  { keyword: "arrancador",    weight: 5,  category: "Variadores" },
  // Repuestos
  { keyword: "repuesto",      weight: 8,  category: "Repuestos" },
  { keyword: "repuestos",     weight: 8,  category: "Repuestos" },
  { keyword: "pieza",         weight: 5,  category: "Repuestos" },
  // Intención de compra
  { keyword: "compra",        weight: 10, category: "Intención de Compra" },
  { keyword: "comprar",       weight: 10, category: "Intención de Compra" },
  { keyword: "pedido",        weight: 10, category: "Intención de Compra" },
  { keyword: "urgente",       weight: 20, category: "Intención de Compra" },
  // Servicio / Mantenimiento
  { keyword: "catálogo",      weight: 5,  category: "Consulta" },
  { keyword: "catalogo",      weight: 5,  category: "Consulta" },
  { keyword: "visita",        weight: 8,  category: "Servicio" },
  { keyword: "mantenimiento", weight: 8,  category: "Servicio" },
  { keyword: "servicio",      weight: 5,  category: "Servicio" },
  // Señales negativas
  { keyword: "gracias",       weight: -5, category: "Cierre / Negativo" },
  { keyword: "compré",        weight: -20, category: "Cierre / Negativo" },
  { keyword: "compramos",     weight: -15, category: "Cierre / Negativo" },
  { keyword: "no gracias",    weight: -10, category: "Cierre / Negativo" },
];

// ─── Text loader (mirrors logic in clientProfiles.ts for consistency) ─────────

async function loadClientText(clientId: number): Promise<string> {
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.clientId, clientId));

  let text = conversations
    .slice(0, 10)
    .map((c) => [c.lastMessage, c.aiSummary].filter(Boolean).join(" "))
    .join(" ");

  if (conversations.length > 0) {
    const messages = await db
      .select({ content: messagesTable.content })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversations[0]!.id));
    text += " " + messages.map((m) => m.content ?? "").join(" ");
  }

  return text;
}

// ─── Keyword scoring ──────────────────────────────────────────────────────────

function countOccurrences(text: string, keyword: string): number {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(kw, pos)) !== -1) {
    count++;
    pos += kw.length;
  }
  return count;
}

// ─── Threshold lookup ─────────────────────────────────────────────────────────

function applyThreshold(
  score: number,
  rules: Array<{ minScore: number; maxScore: number; value: string }>,
  defaults: Array<{ minScore: number; maxScore: number; value: string }>,
): string {
  const set = rules.length > 0 ? rules : defaults;
  return (
    set.find((r) => score >= r.minScore && score <= r.maxScore)?.value ??
    set[set.length - 1]!.value
  );
}

// ─── Public result type ───────────────────────────────────────────────────────

export interface CIEResult {
  baseScore: number;
  keywordScore: number;
  finalScore: number;
  enginePriority: string;
  engineStage: string;
  appliedRules: AppliedRule[];
  scoreBreakdown: Record<string, number>;
  computedAt: string;
}

// ─── Main engine run ──────────────────────────────────────────────────────────

export async function runCommercialEngine(
  workspaceId: number,
  clientId: number,
): Promise<CIEResult> {
  // Step 1: run the existing profile engine (preserves exact commercialScore formula)
  await computeClientProfile(workspaceId, clientId);

  const [profile] = await db
    .select()
    .from(clientProfilesTable)
    .where(
      and(
        eq(clientProfilesTable.clientId, clientId),
        eq(clientProfilesTable.workspaceId, workspaceId),
      ),
    );

  const baseScore = profile?.commercialScore ?? 0;
  const scoreBreakdown: Record<string, number> = {
    ...(profile?.scoreBreakdown ?? {}),
  };

  // Step 2: load keywords from DB (fall back to empty → no extra points)
  const keywords = await db
    .select()
    .from(commercialKeywordsTable)
    .where(eq(commercialKeywordsTable.workspaceId, workspaceId));

  // Step 3: scan conversation text
  const text = keywords.length > 0 ? await loadClientText(clientId) : "";

  // Step 4: score each keyword that fires
  const appliedRules: AppliedRule[] = [];
  let keywordScore = 0;

  for (const kw of keywords) {
    const occurrences = countOccurrences(text, kw.keyword);
    if (occurrences === 0) continue;

    // Cap contribution per keyword at 3× its weight to avoid runaway scores
    const raw = kw.weight * occurrences;
    const capped = kw.weight >= 0
      ? Math.min(raw, Math.abs(kw.weight) * 3)
      : Math.max(raw, -(Math.abs(kw.weight) * 3));

    keywordScore += capped;
    scoreBreakdown[`keyword:${kw.keyword}`] = capped;

    appliedRules.push({
      label: kw.keyword,
      keyword: kw.keyword,
      occurrences,
      delta: capped,
      category: kw.category,
      reason: `"${kw.keyword}" aparece ${occurrences} ${occurrences === 1 ? "vez" : "veces"} (peso ${kw.weight > 0 ? "+" : ""}${kw.weight})`,
    });
  }

  // Step 5: compute final score from base + keyword delta
  const finalScore = Math.min(100, Math.max(0, baseScore + keywordScore));

  // Step 6: load configurable priority / stage rules
  const allRules = await db
    .select()
    .from(commercialRulesTable)
    .where(eq(commercialRulesTable.workspaceId, workspaceId));

  const priorityRules = allRules.filter((r) => r.type === "priority");
  const stageRules    = allRules.filter((r) => r.type === "stage");

  const enginePriority = applyThreshold(finalScore, priorityRules, DEFAULT_PRIORITY_RULES);
  const engineStage    = applyThreshold(finalScore, stageRules,    DEFAULT_STAGE_RULES);

  const computedAt = new Date().toISOString();

  return {
    baseScore,
    keywordScore,
    finalScore,
    enginePriority,
    engineStage,
    appliedRules,
    scoreBreakdown,
    computedAt,
  };
}

// ─── Sync: run engine AND write back to client + profile ─────────────────────

export async function syncCommercialState(
  workspaceId: number,
  clientId: number,
): Promise<CIEResult> {
  const result = await runCommercialEngine(workspaceId, clientId);

  // Update client.priority and client.stage
  await db
    .update(clientsTable)
    .set({ priority: result.enginePriority, stage: result.engineStage })
    .where(
      and(
        eq(clientsTable.id, clientId),
        eq(clientsTable.workspaceId, workspaceId),
      ),
    );

  // Update profile with CIE results
  await db
    .update(clientProfilesTable)
    .set({
      commercialScore: result.finalScore,
      keywordScore:    result.keywordScore,
      scoreBreakdown:  result.scoreBreakdown,
      enginePriority:  result.enginePriority,
      engineStage:     result.engineStage,
      appliedRules:    result.appliedRules,
      computedAt:      new Date(),
    })
    .where(
      and(
        eq(clientProfilesTable.clientId, clientId),
        eq(clientProfilesTable.workspaceId, workspaceId),
      ),
    );

  return result;
}

// ─── Seed default keywords for a fresh workspace ──────────────────────────────

export async function seedDefaultKeywords(workspaceId: number): Promise<void> {
  const existing = await db
    .select({ id: commercialKeywordsTable.id })
    .from(commercialKeywordsTable)
    .where(eq(commercialKeywordsTable.workspaceId, workspaceId));

  if (existing.length > 0) return; // already seeded

  await db.insert(commercialKeywordsTable).values(
    DEFAULT_SEED_KEYWORDS.map((kw) => ({ ...kw, workspaceId })),
  );
}
