/**
 * Motor Catalog Query Engine
 *
 * Layer order:
 *   1. Static knowledge base (SIMOTICS_MOTORS) — always available, instant.
 *   2. Uploaded PDF/Excel catalog content — extracted text from uploaded docs.
 *   3. AI Vision extraction — called when the PDF is image-based (no text).
 *
 * Respects the `catalogPolicy` stored in ai_settings to control which fields
 * are included in the formatted response.
 */

import { SIMOTICS_MOTORS, type MotorSpec } from "../data/simotics-motors";
import { getVisionModel, isAIReady, AI_DISCONNECTED_MESSAGE } from "./aiProvider";
import { db } from "@workspace/db";
import { aiSettingsTable } from "@workspace/db";
import { logger } from "../lib/logger";

// ─── Catalog policy ──────────────────────────────────────────────────────────

export interface CatalogPolicy {
  detailLevel: "brief" | "standard" | "detailed" | "technical_full";
  showFrame: boolean;
  showRpm: boolean;
  showCurrent: boolean;
  showPowerFactor: boolean;
  showEfficiency: boolean;
  showWeight: boolean;
  showMounting: boolean;
  showOrderCode: boolean;
  showTension: boolean;
  showBearings: boolean;
  showShaftDiameter: boolean;
}

export const DEFAULT_CATALOG_POLICY: CatalogPolicy = {
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
};

export async function getCatalogPolicy(workspaceId?: number): Promise<CatalogPolicy> {
  try {
    const { eq } = await import("drizzle-orm");
    const query = db.select().from(aiSettingsTable);
    const [settings] = workspaceId !== undefined
      ? await query.where(eq(aiSettingsTable.workspaceId, workspaceId)).limit(1)
      : await query.limit(1);
    const raw = (settings as any)?.catalogPolicy;
    if (raw && typeof raw === "object") {
      return { ...DEFAULT_CATALOG_POLICY, ...raw } as CatalogPolicy;
    }
  } catch (_) { /* fall through */ }
  return DEFAULT_CATALOG_POLICY;
}

// ─── Query parameters (shared with ai.ts normalizer) ────────────────────────

export interface MotorQuery {
  hp: number | null;
  kw: number | null;
  poles: number | null;
}

/** Normalizes Spanish decimal comma (1,5 → 1.5) */
function normalizeDecimal(s: string): string {
  return s.replace(/(\d),(\d)/g, "$1.$2");
}

/** Parse motor query params from natural language */
export function parseMotorQuery(text: string): MotorQuery {
  const norm = normalizeDecimal(text);
  const lower = norm.toLowerCase();

  let hp: number | null = null;
  const hpMatch = lower.match(/(\d+\.?\d*)\s*hp/) ?? lower.match(/(\d+\.?\d*)\s*caball/);
  if (hpMatch) hp = parseFloat(hpMatch[1]);

  let poles: number | null = null;
  const polesMatch = lower.match(/(\d+)\s*pol[oe]s?/);
  if (polesMatch) {
    poles = parseInt(polesMatch[1]);
  } else if (/bipolar|2\s*polo/.test(lower)) {
    poles = 2;
  } else if (/tetrapolar|4\s*polo/.test(lower)) {
    poles = 4;
  } else if (/hexapolar|6\s*polo/.test(lower)) {
    poles = 6;
  } else if (/octopolar|8\s*polo/.test(lower)) {
    poles = 8;
  }

  let kw: number | null = null;
  const kwMatch = lower.match(/(\d+\.?\d*)\s*kw/);
  if (kwMatch) kw = parseFloat(kwMatch[1]);

  return { hp, kw, poles };
}

// ─── KB lookup ───────────────────────────────────────────────────────────────

export interface KbLookupResult {
  motors: MotorSpec[];
  nearestHp: number | null;   // set when no exact match found
  usedKw: number | null;      // the kW value used for lookup
  source: "exact" | "nearest" | "notfound";
}

/**
 * True synonyms only — labels that commercially refer to the SAME motor.
 * Never map approximate or "close enough" values here; those go through
 * the nearest-HP fallback so the approximation warning is shown correctly.
 */
const HP_ALIASES: Record<number, number[]> = {
  // Catalog HP  → acceptable query HP values (true equivalents)
  0.25: [0.25, 1 / 4],
  0.33: [0.33, 1 / 3],
  0.50: [0.5, 0.50, 1 / 2],
  0.75: [0.75, 3 / 4],
  1.00: [1, 1.0],
  1.50: [1.5],
  2.00: [2, 2.0],
  3.00: [3],
  4.00: [4],
  5.50: [5.5, 5],    // 5 HP is close enough to 5.5 to be considered same
  7.50: [7.5, 7],    // 7 HP → 7.5 HP is standard commercial label
  10.0: [10],
  15.0: [15],
  20.0: [20],
  25.0: [25],
  30.0: [30],
  40.0: [40],
  50.0: [50],
  60.0: [60],
  75.0: [75],
  100:  [100],
  125:  [125],   // 120 HP is NOT the same as 125 HP — use nearest fallback
  150:  [150],
  175:  [175],   // 180 HP is NOT 175 HP — nearest fallback applies
  215:  [215],   // 200/220 HP differ — nearest fallback
  270:  [270],   // 250/265 HP differ — nearest fallback
  340:  [340],   // 335/350 HP differ — nearest fallback
};

/** Convert kW to approximate HP for lookup tolerance */
function kwToHp(kw: number): number {
  return kw / 0.7457;
}

function findMotorsByHp(targetHp: number, poles: number | null): KbLookupResult {
  // Try exact match first (within ±2%)
  const exact = SIMOTICS_MOTORS.filter(m => {
    const poleOk = poles === null || m.poles === poles;
    return poleOk && Math.abs(m.hp - targetHp) / Math.max(m.hp, 1) < 0.02;
  });

  if (exact.length) {
    return { motors: exact, nearestHp: null, usedKw: exact[0]?.kw ?? null, source: "exact" };
  }

  // Try alias matching — only TRUE synonyms (same motor, different label)
  for (const [stdHpStr, aliases] of Object.entries(HP_ALIASES)) {
    const stdHp = parseFloat(stdHpStr);
    if ((aliases as number[]).some(a => Math.abs(a - targetHp) / Math.max(Math.abs(a), 1) < 0.01)) {
      // Only return as "exact" if the alias IS the catalog HP or within strict ±2%
      const candidates = SIMOTICS_MOTORS.filter(m => {
        const poleOk = poles === null || m.poles === poles;
        return poleOk && Math.abs(m.hp - stdHp) / Math.max(m.hp, 1) < 0.02;
      });
      if (candidates.length) {
        return { motors: candidates, nearestHp: null, usedKw: candidates[0]?.kw ?? null, source: "exact" };
      }
    }
  }

  // Nearest HP fallback
  const allHpValues = [...new Set(
    SIMOTICS_MOTORS.filter(m => poles === null || m.poles === poles).map(m => m.hp)
  )].sort((a, b) => a - b);

  if (!allHpValues.length) return { motors: [], nearestHp: null, usedKw: null, source: "notfound" };

  const closestHp = allHpValues.reduce(
    (prev, curr) => Math.abs(curr - targetHp) < Math.abs(prev - targetHp) ? curr : prev,
  );
  const nearest = SIMOTICS_MOTORS.filter(m => {
    const poleOk = poles === null || m.poles === poles;
    return poleOk && Math.abs(m.hp - closestHp) < 0.01;
  });
  return { motors: nearest, nearestHp: closestHp, usedKw: nearest[0]?.kw ?? null, source: nearest.length ? "nearest" : "notfound" };
}

export function lookupMotors(params: MotorQuery): KbLookupResult {
  const { hp, kw, poles } = params;

  if (hp !== null) {
    return findMotorsByHp(hp, poles);
  }
  if (kw !== null) {
    return findMotorsByHp(kwToHp(kw), poles);
  }
  // No power specified — if only poles specified, return all for that pole count
  if (poles !== null) {
    const motors = SIMOTICS_MOTORS.filter(m => m.poles === poles);
    return { motors, nearestHp: null, usedKw: null, source: motors.length ? "exact" : "notfound" };
  }
  return { motors: [], nearestHp: null, usedKw: null, source: "notfound" };
}

// ─── Response formatter ──────────────────────────────────────────────────────

function fieldLine(label: string, value: string | number | boolean, unit = ""): string {
  return `  • ${label}: ${value}${unit ? " " + unit : ""}`;
}

function formatSingleMotor(m: MotorSpec, policy: CatalogPolicy): string {
  const lines: string[] = [];

  // Always shown
  lines.push(`🔧 *${m.kw} kW (${m.hp} HP) — ${m.poles} polos*`);

  if (policy.showFrame)         lines.push(fieldLine("Tamaño constructivo", `Frame ${m.frame} (h = ${m.shaftHeightMm} mm)`));
  if (policy.showRpm)           lines.push(fieldLine("Velocidad", `≈ ${m.rpm50hz} rpm (50 Hz)`));
  if (policy.showCurrent)       lines.push(fieldLine("Corriente nominal", m.currentA400V, "A @ 400 V"));
  if (policy.showEfficiency)    lines.push(fieldLine("Rendimiento IE3", m.efficiencyIE3, "%"));
  if (policy.showPowerFactor)   lines.push(fieldLine("Factor de potencia", m.cosPhi));
  if (policy.showWeight)        lines.push(fieldLine("Peso aprox.", m.weightKg, "kg"));
  if (policy.showTension)       lines.push(fieldLine("Tensión", m.tensionV));
  if (policy.showMounting)      lines.push(fieldLine("Montaje disponible", m.mounting.join(" / ")));
  if (policy.showShaftDiameter) lines.push(fieldLine("Diámetro de eje", m.shaftDiameterMm, "mm"));
  if (policy.showBearings)      lines.push(fieldLine("Rodamientos", `DE: ${m.bearingDE} / NDE: ${m.bearingNDE}`));
  if (policy.showOrderCode)     lines.push(fieldLine("Código familia", m.orderCodeBase));

  // Always shown (standard catalog info)
  lines.push(fieldLine("Protección / Aislación", `${m.ip} / Clase ${m.insulationClass}`));
  lines.push(fieldLine("Refrigeración / Servicio", `${m.cooling} / ${m.service}`));
  lines.push(fieldLine("Temp. ambiente / Altitud", `${m.ambientTempC}°C / ${m.altitudeM} m s.n.m.`));

  return lines.join("\n");
}

function formatMultipleMotors(motors: MotorSpec[], policy: CatalogPolicy): string {
  if (policy.detailLevel === "brief") {
    return motors.map(m =>
      `  ◦ ${m.kw} kW (${m.hp} HP) — Frame ${m.frame} — ≈ ${m.rpm50hz} rpm — ${m.currentA400V} A @ 400 V`
    ).join("\n");
  }
  return motors.map(m => formatSingleMotor(m, policy)).join("\n\n");
}

export function formatCatalogResponse(
  result: KbLookupResult,
  params: MotorQuery,
  contactName: string,
  policy: CatalogPolicy,
): string {
  if (!result.motors.length) return "";

  const approxNote = result.nearestHp
    ? `\n\n⚠️ No encontramos un motor de exactamente ${params.hp ?? (params.kw ? (params.kw / 0.7457).toFixed(1) : "?")} HP en nuestra base. La opción más cercana es *${result.nearestHp} HP*:`
    : "";

  const polesNote = params.poles ? ` (${params.poles} polos)` : "";
  const powerNote = params.hp ? `${params.hp} HP` : params.kw ? `${params.kw} kW` : "la potencia solicitada";

  if (result.motors.length === 1) {
    const m = result.motors[0];
    const header = approxNote
      ? `Estimado ${contactName},${approxNote}\n\n`
      : `Estimado ${contactName}, estas son las características técnicas del motor SIMOTICS GP ${powerNote}${polesNote}:\n\n`;
    return header + formatSingleMotor(m, policy) +
      "\n\n¿Necesita información adicional, disponibilidad de stock o código de pedido completo?";
  }

  // Multiple motors (varios polos, etc.)
  const header = approxNote
    ? `Estimado ${contactName},${approxNote}\n\n`
    : `Estimado ${contactName}, disponemos de las siguientes versiones de motor ${powerNote} en distintos polos:\n\n`;

  return header + formatMultipleMotors(result.motors, policy) +
    "\n\n¿Cuál versión necesita? También puedo confirmarle código de pedido y disponibilidad de stock.";
}

// ─── AI Vision PDF extraction ─────────────────────────────────────────────────

/** Extract motor specs from PDF pages using Groq Vision API (llama vision) */
export async function extractPdfWithVision(
  base64Pages: string[],
  docName: string,
): Promise<string> {
  // BYO AI gate — PDF vision extraction requires a verified provider
  const { ready: visionReady, reason: visionReason } = isAIReady();
  if (!visionReady) {
    throw new Error(AI_DISCONNECTED_MESSAGE);
  }
  const { getAIClient } = await import("./aiProvider");
  const client = getAIClient(undefined, "extractPdfWithVision");
  const visionModel = getVisionModel();
  const allText: string[] = [];

  for (let i = 0; i < base64Pages.length; i++) {
    const pageNum = i + 1;
    logger.info({ doc: docName, page: pageNum, total: base64Pages.length }, "Extracting PDF page with AI Vision");

    try {
      const response = await client.chat.completions.create({
        model: visionModel,
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64Pages[i]}` },
            },
            {
              type: "text",
              text: `Extrae TODO el contenido textual de esta página del catálogo de motores Siemens/Innomotics.
Incluye:
- Tablas de selección (frame IEC, potencia, velocidad, corriente, rendimiento, peso)
- Datos técnicos (dimensiones A, B, C, D, E, F, G, H)
- Códigos de pedido y denominaciones
- Cualquier número, unidad o etiqueta visible
Formato: preserva la estructura usando | para columnas de tablas.
Página ${pageNum} de ${base64Pages.length}. Solo el texto extraído, sin comentarios.`,
            },
          ],
        }],
      });

      const text = response.choices[0]?.message?.content ?? "";
      if (text.trim()) {
        allText.push(`\n=== Página ${pageNum} ===\n${text.trim()}`);
      }
    } catch (e) {
      logger.warn({ err: e, page: pageNum }, "Vision extraction failed for page");
    }
  }

  return allText.join("\n");
}
