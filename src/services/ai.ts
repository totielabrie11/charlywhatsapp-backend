import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  messagesTable, conversationsTable,
  aiSettingsTable, aiRolesTable, documentsTable, tasksTable,
  roleDocumentsTable, restrictionPoliciesTable, clientsTable,
} from "@workspace/db";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { emit as socketEmit } from "../lib/socket";
import {
  lookupMotors, parseMotorQuery, formatCatalogResponse, getCatalogPolicy,
} from "./catalogQuery";
import { getAIClient, getAIModel, isAIReady, logAIBlocked, AI_DISCONNECTED_MESSAGE, AINotConfiguredError } from "./aiProvider";

// Fase 4.2: async token usage logger (fire-and-forget — never blocks the AI response)
async function _logTokenUsage(model: string, endpoint: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined) {
  if (!usage) return;
  try {
    const { tokenUsageTable } = await import("@workspace/db");
    await db.insert(tokenUsageTable).values({
      model,
      endpoint,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    });
  } catch (e) {
    logger.warn({ err: e }, "Token usage log failed");
  }
}

/** Returns the active AI client for a workspace (delegates to AI Provider Manager). */
function getClient(workspaceId?: number): OpenAI {
  return getAIClient(workspaceId);
}

// ─── Multi-role helpers ───────────────────────────────────────────────────────

/** Returns ALL roles with active=true (multi-active). Falls back to default. */
async function getActiveRoles(workspaceId: number) {
  try {
    const roles = await db
      .select()
      .from(aiRolesTable)
      .where(and(eq(aiRolesTable.workspaceId, workspaceId), eq(aiRolesTable.active, true)));
    if (roles.length) return roles;
    // Fallback: return the default role even if not active
    const [defaultRole] = await db
      .select()
      .from(aiRolesTable)
      .where(and(eq(aiRolesTable.workspaceId, workspaceId), eq(aiRolesTable.isDefault, true)));
    return defaultRole ? [defaultRole] : [];
  } catch (_) {
    return [];
  }
}

/** Fetch document content assigned to a role — only indexed (text-extracted) docs */
async function getRoleDocumentSnippets(roleId: number): Promise<string[]> {
  try {
    const rows = await db
      .select({ content: documentsTable.content, name: documentsTable.name })
      .from(roleDocumentsTable)
      .innerJoin(documentsTable, eq(roleDocumentsTable.documentId, documentsTable.id))
      .where(and(eq(roleDocumentsTable.roleId, roleId), eq(documentsTable.indexed, true)));
    return rows
      .filter(r => r.content && isReadableText(r.content))
      .slice(0, 5)
      .map(r => `--- ${r.name} ---\n${r.content!.substring(0, 3000)}`);
  } catch (_) {
    return [];
  }
}

/** Fetch enabled restriction policies */
async function getEnabledRestrictions(workspaceId: number): Promise<string[]> {
  try {
    const rows = await db
      .select({ rule: restrictionPoliciesTable.rule })
      .from(restrictionPoliciesTable)
      .where(and(eq(restrictionPoliciesTable.workspaceId, workspaceId), eq(restrictionPoliciesTable.enabled, true)));
    return rows.map(r => r.rule);
  } catch (_) {
    return [];
  }
}

/** Fetch enabled priority policies (mandatory questions/actions) */
async function getEnabledPriorityPolicies(workspaceId: number): Promise<string[]> {
  try {
    const { priorityPoliciesTable } = await import("@workspace/db");
    const rows = await db
      .select({ rule: priorityPoliciesTable.rule })
      .from(priorityPoliciesTable)
      .where(and(eq(priorityPoliciesTable.workspaceId, workspaceId), eq(priorityPoliciesTable.enabled, true)));
    return rows.map(r => r.rule);
  } catch (_) {
    return [];
  }
}

/** Build a complete system prompt from all active roles + their docs + restriction policies */
async function buildSystemPrompt(opts?: {
  workspaceId: number;
  includeRoleDocs?: boolean;
  /** Pre-searched dynamic context to inject instead of static first-3000-chars snippets */
  dynamicContext?: string;
}): Promise<string> {
  const wid = opts?.workspaceId ?? 1; // safe fallback — callers always supply workspaceId
  const [roles, userRestrictions, priorityRules, settings] = await Promise.all([
    getActiveRoles(wid),
    getEnabledRestrictions(wid),
    getEnabledPriorityPolicies(wid),
    db.select().from(aiSettingsTable).where(eq(aiSettingsTable.workspaceId, wid)).limit(1).then(rows => rows[0] ?? null),
  ]);

  // ── Priority / mandatory consultation rules — FIRST so the LLM prioritizes them ──
  const prioritySection = priorityRules.length > 0
    ? `INSTRUCCIONES OBLIGATORIAS — SEGUIR ANTES DE CUALQUIER RESPUESTA:\n${priorityRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\nEstas instrucciones tienen prioridad absoluta sobre cualquier otra consideración.\n\n`
    : "";

  // ── Role persona section ──
  let roleSection: string;
  if (roles.length === 0) {
    roleSection =
      "Sos un asistente comercial técnico especializado en equipos industriales: motores eléctricos, bombas, reductores, variadores y equipos OEM de Siemens-Innomotics. Tenés 30 años de experiencia.";
  } else if (roles.length === 1) {
    const r = roles[0];
    roleSection = r.personality;
    if (r.specialties?.length) {
      roleSection += ` Especialidades: ${r.specialties.join(", ")}.`;
    }
  } else {
    roleSection = "Sos un asistente con múltiples capacidades combinadas:\n";
    for (const r of roles) {
      roleSection += `\n[${r.name}]: ${r.personality}`;
      if (r.specialties?.length) {
        roleSection += ` Especialidades: ${r.specialties.join(", ")}.`;
      }
    }
  }

  // ── Documents section ──
  let docsSection = "";
  if (opts?.dynamicContext) {
    docsSection = `\n\nINFORMACIÓN DE REFERENCIA PARA ESTA CONSULTA — usá esto para responder con precisión:\n${opts.dynamicContext}`;
  } else if (opts?.includeRoleDocs && roles.length) {
    const allSnippets: string[] = [];
    for (const role of roles) {
      const snippets = await getRoleDocumentSnippets(role.id);
      allSnippets.push(...snippets);
    }
    if (allSnippets.length) {
      docsSection = `\n\nINFORMACIÓN DE REFERENCIA — usá esto para responder con precisión:\n${allSnippets.slice(0, 6).join("\n\n")}`;
    }
  }

  // ── Catalog lines restriction (features 4/5/6) ────────────────────────────
  let catalogSection = "";
  if (settings) {
    const lines = (settings.catalogLines as Array<{ name: string; enabled: boolean }>) ?? [];
    const enabled = lines.filter(l => l.enabled).map(l => l.name);
    if (enabled.length > 0) {
      catalogSection =
        `\n\nLÍNEAS DE PRODUCTOS DISPONIBLES (solo estas):\n${enabled.map(n => `✔ ${n}`).join("\n")}\n` +
        `Si el cliente pregunta por una línea, producto o equipo que NO esté en esta lista, respondé: ` +
        `"No contamos con esa línea actualmente." No inventes ni supongas disponibilidad.`;
    }

    // ── Catalog policy: detail level and visible fields ──────────────────────
    // catalogPolicy lives in ai_settings and controls WHAT technical data to include
    // in catalog responses (frame, rpm, current, weight, etc.) and at what depth.
    const policy = (settings as any).catalogPolicy as Record<string, unknown> | null | undefined;
    if (policy && typeof policy === "object") {
      const detailMap: Record<string, string> = {
        brief:          "MUY BREVE — indicá solo potencia, polos y frame constructivo",
        standard:       "ESTÁNDAR — incluí potencia, polos, frame, RPM y corriente nominal",
        detailed:       "DETALLADO — incluí todos los parámetros mecánicos y eléctricos disponibles",
        technical_full: "TÉCNICO COMPLETO — incluí ficha técnica completa con normas, código de pedido y todos los parámetros",
      };
      const detailLevel = (policy.detailLevel as string) ?? "standard";
      const detailInstr = detailMap[detailLevel] ?? detailMap.standard;

      const fieldLabels: [string, string][] = [
        ["showFrame",         "frame IEC / NEMA"],
        ["showRpm",           "velocidad (RPM)"],
        ["showCurrent",       "corriente nominal (A)"],
        ["showEfficiency",    "eficiencia IE"],
        ["showWeight",        "peso (kg)"],
        ["showPowerFactor",   "factor de potencia (cos φ)"],
        ["showMounting",      "tipo de montaje (B3/B5/etc.)"],
        ["showOrderCode",     "código de pedido"],
        ["showTension",       "tensión de trabajo (V)"],
        ["showBearings",      "rodamientos"],
        ["showShaftDiameter", "diámetro de eje (mm)"],
      ];
      const shownFields = fieldLabels.filter(([key]) => policy[key] === true).map(([, label]) => label);

      catalogSection += `\n\nNIVEL DE DETALLE PARA RESPUESTAS DE CATÁLOGO: ${detailInstr}.`;
      if (shownFields.length > 0) {
        catalogSection += `\nCampos a incluir en respuestas técnicas: ${shownFields.join(", ")}.`;
        catalogSection += `\nNo incluyas campos que no estén en esa lista salvo que el cliente lo pida explícitamente.`;
      }
    }
  }

  // ── Response style section (features 3/7/8/9/10) ─────────────────────────
  let styleSection = "";
  if (settings) {
    const lengthMap: Record<string, string> = {
      muy_breve: "MUY BREVE (máximo 1-2 oraciones, directo al punto, sin explicaciones adicionales)",
      breve:     "BREVE (2-3 oraciones, confirma la disponibilidad y ofrece el siguiente paso)",
      normal:    "NORMAL (2-3 párrafos cortos, balanceado entre información y concisión)",
      detallada: "DETALLADA (4-6 párrafos, incluye especificaciones técnicas relevantes)",
      tecnica:   "TÉCNICA (respuesta completa con especificaciones, normas, parámetros y datos de catálogo)",
    };
    const formalityMap: Record<string, string> = {
      muy_formal: "MUY FORMAL — tratamiento de usted, vocabulario corporativo, sin contracciones",
      comercial:  "COMERCIAL — profesional pero cercano, vos/usted intercambiable según el cliente",
      cercano:    "CERCANO — tuteo, tono amigable, informal sin ser descuidado",
      tecnico:    "TÉCNICO — lenguaje de ingeniería, preciso, sin adornos comerciales",
      ejecutivo:  "EJECUTIVO — conciso, orientado a decisiones, sin rodeos",
    };

    const lengthInstr = lengthMap[settings.responseLength ?? "normal"] ?? lengthMap.normal;
    const formalityInstr = formalityMap[settings.formalityLevel ?? "comercial"] ?? formalityMap.comercial;
    const emojiInstr = settings.useEmojis
      ? "Podés usar emojis con moderación para hacer la respuesta más amigable."
      : "NO uses emojis. El cliente es industrial/corporativo y prefiere comunicación sin emojis.";

    let maxWordsInstr = "";
    if (settings.maxWords && settings.maxWords > 0) {
      maxWordsInstr = `\nLÍMITE ESTRICTO: Nunca superes las ${settings.maxWords} palabras en tu respuesta.`;
    }

    styleSection = `\n\nESTILO DE RESPUESTA (seguir estrictamente):\n` +
      `- Longitud: ${lengthInstr}\n` +
      `- Formalidad: ${formalityInstr}\n` +
      `- Emojis: ${emojiInstr}` +
      maxWordsInstr;

    if (settings.signature?.trim()) {
      styleSection += `\n- Firma: Cerrá SIEMPRE tu respuesta con esta firma exacta:\n${settings.signature.trim()}`;
    }
  }

  // ── Hard restriction rules ────────────────────────────────────────────────
  const baseRules = [
    "PRECIO: Nunca menciones ni estimes precios, costos, valores o tarifas que NO aparezcan textualmente en los documentos de referencia proporcionados. Si el cliente pregunta por precio y no está en los documentos, respondé exactamente: 'No tengo ese precio disponible en este momento. Te lo consigo y te aviso a la brevedad.'",
    "PRECIO (refuerzo): Si ves números de precio en tu entrenamiento pero NO en los documentos de contexto de esta conversación, ignoralos completamente. Solo los precios de los documentos adjuntos son válidos.",
    "Nunca prometas fechas de entrega sin confirmar stock real.",
    "Si tenés dudas sobre un dato técnico, pedí más información al cliente antes de responder.",
    "Si el cliente habla en español, respondé en español.",
  ];
  const allRules = [...baseRules, ...userRestrictions];
  const restrictionSection = `\n\nREGLAS OBLIGATORIAS (nunca las ignorés):\n${allRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;

  const contextSection =
    "\n\nContexto: Sos el asistente de Cruzzolin Materiales Eléctricos, distribuidor de equipos industriales Siemens-Innomotics.";

  return `${prioritySection}${roleSection}${docsSection}${catalogSection}${styleSection}${restrictionSection}${contextSection}`;
}

// ─── Public AI functions ──────────────────────────────────────────────────────

// ── Shared price-intent helper ────────────────────────────────────────────────
// Used by both suggestReply and buildDynamicDocContext so both apply the same
// normalized, accent-insensitive detection logic.
function detectPriceIntent(text: string): boolean {
  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const norm = normalize(text);
  return (
    [
      "precio", "precios", "costo", "costos", "cotiz", "cotizar", "cotizacion",
      "cuanto cuesta", "cuanto sale", "cuanto vale", "cuanto me sale",
      "cuanto me cuesta", "cuanto me cobran",
      "valor", "lista de precio", "lista precio", "tarifa",
      "presupuesto", "presupuestar",
    ].some(kw => norm.includes(normalize(kw)))
    || /\$\s*\d/.test(text)
    || /\bcuant[ao]\b.{0,40}(cuesta|sale|cobran|vale|precio|costo|valor)/.test(norm)
    || /(precio|costo|valor|sale|cuesta|cobran).{0,40}\bcuant[ao]\b/.test(norm)
  );
}

/**
 * Build query-aware document context for a given user message.
 * Mirrors the search logic in suggestReply but returns raw text for LLM injection
 * instead of a formatted template response.
 */
async function buildDynamicDocContext(userText: string, workspaceId: number): Promise<string> {
  const contextParts: string[] = [];
  const isPriceQuery = detectPriceIntent(userText);

  // 1. Static KB lookup (SIMOTICS motor catalog) — skip for price queries (KB has no pricing)
  const motorParams = extractMotorQueryParams(userText);
  if (!isPriceQuery && (motorParams.hp !== null || motorParams.kw !== null)) {
    const kbResult = lookupMotors(motorParams);
    if (kbResult.motors.length > 0) {
      const kbText = kbResult.motors
        .map(m =>
          `Motor SIMOTICS GP: ${m.kw} kW (${m.hp} HP) | ${m.poles} polos | ` +
          `Frame IEC ${m.frame} | ${(m as any).rpm50hz ?? (m as any).rpm ?? "–"} rpm | IE3 | IP55 | ` +
          `${m.weightKg ?? "–"} kg | Corriente: ${(m as any).currentA400V ?? (m as any).ia ?? "–"} A`
        )
        .join("\n");
      contextParts.push(`[Catálogo SIMOTICS GP]\n${kbText}`);
    }
  }

  // 2. Role document search — dynamic, query-aware
  const topics = detectTopics(userText);
  const activeRoles = await getActiveRoles(workspaceId);
  const scored = activeRoles
    .map(r => ({ role: r, score: roleMatchesTopics(r, topics) }))
    .sort((a, b) => b.score - a.score);

  const bestMatch = scored[0];
  if (bestMatch && bestMatch.score > 0) {
    const docs = await db
      .select({ content: documentsTable.content, name: documentsTable.name })
      .from(roleDocumentsTable)
      .innerJoin(documentsTable, eq(roleDocumentsTable.documentId, documentsTable.id))
      .where(and(eq(roleDocumentsTable.roleId, bestMatch.role.id), eq(documentsTable.indexed, true)));

    for (const doc of docs) {
      const content = doc.content ?? "";
      if (!isReadableText(content)) continue;

      const firstDataLine = content.split("\n").find(l => l.trim() && !l.startsWith("===")) ?? "";

      if (isPriceListCsv(firstDataLine)) {
        if (motorParams.hp !== null || motorParams.kw !== null || motorParams.poles !== null) {
          // Specs known → structured lookup
          const result = queryPriceList(content, motorParams);
          if (result.rows.length) {
            const headers = result.headers.join(" | ");
            const rows = result.rows.map(r => result.headers.map(h => r[h] ?? "").join(" | ")).join("\n");
            contextParts.push(`[Lista de precios: ${doc.name}]\n${headers}\n${rows}`);
            break;
          } else if (result.nearestHp !== null) {
            const nearResult = queryPriceList(content, { ...motorParams, hp: result.nearestHp, kw: null });
            if (nearResult.rows.length) {
              const headers = nearResult.headers.join(" | ");
              const rows = nearResult.rows.map(r => nearResult.headers.map(h => r[h] ?? "").join(" | ")).join("\n");
              contextParts.push(
                `[Lista de precios: ${doc.name}]\n` +
                `NOTA: la potencia exacta solicitada no está en lista; el valor más cercano disponible es ${result.nearestHp} HP.\n` +
                `${headers}\n${rows}`
              );
              break;
            }
          }
        } else if (isPriceQuery) {
          // Price intent but no specs → show header + first 20 rows so LLM can describe the range
          const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("==="));
          contextParts.push(`[Lista de precios: ${doc.name}]\n${lines.slice(0, 21).join("\n")}`);
          break;
        }
        // No specs + no price intent → skip CSV, continue to next doc
      } else {
        // Free-text document — keyword search
        const excerpt = searchDocumentForTopics(content, topics, userText);
        if (excerpt) {
          contextParts.push(`[Documento: ${doc.name}]\n${excerpt.substring(0, 1500)}`);
          break;
        }
      }
    }
  }

  return contextParts.join("\n\n");
}

export async function generateAISuggestion(
  conversationId: number,
  _lastMessage: string,
): Promise<string | null> {
  try {
    // BYO AI gate: get workspaceId first, then check readiness.
    // Returns null (not an error message) so auto-reply callers silently skip.
    const [convWs] = await db
      .select({ workspaceId: conversationsTable.workspaceId })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    const wsIdEarly = convWs?.workspaceId;
    const { ready, reason } = isAIReady(wsIdEarly);
    if (!ready) {
      logAIBlocked("generateAISuggestion", reason ?? "no reason", wsIdEarly);
      return null;
    }

    const client = getClient(wsIdEarly);

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(desc(messagesTable.sentAt))
      .limit(10);

    const ordered = messages.reverse(); // chronological order

    // Always send the last INBOUND (user) message — never an outbound/assistant message
    const lastUserMsg = [...ordered].reverse().find(m => m.direction === "inbound");
    const userText = lastUserMsg?.content ?? _lastMessage;
    if (!userText) return null;

    // Build history: everything before the last user message
    const beforeLast = lastUserMsg
      ? ordered.filter(m => m.id !== lastUserMsg.id)
      : ordered.slice(0, -1);

    // Dynamic query-aware document/KB search — runs per message so each query
    // gets fresh, relevant context (not the static first-3000-chars of the doc)
    const wsId = wsIdEarly ?? 1;
    const dynamicContext = await buildDynamicDocContext(userText, wsId);

    const systemPrompt = await buildSystemPrompt({
      workspaceId: wsId,
      dynamicContext: dynamicContext || undefined,
      includeRoleDocs: !dynamicContext, // static fallback only if dynamic search found nothing
    });

    const chatMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...beforeLast.map(m => ({
        role: m.direction === "inbound" ? "user" as const : "assistant" as const,
        content: m.content,
      })),
      { role: "user", content: userText },
    ];

    const activeModel = getAIModel(wsId);
    const completion = await client.chat.completions.create({
      model: activeModel,
      messages: chatMessages,
      max_tokens: 500,
    });

    // Fase 4.2: Log token usage (fire-and-forget)
    _logTokenUsage(activeModel, "generate_suggestion", completion.usage).catch(() => {});

    return completion.choices[0]?.message?.content || null;
  } catch (e) {
    logger.error({ err: e }, "AI suggestion failed");
    return null;
  }
}

// ─── Topic → specialty matching (local, no API) ──────────────────────────────

const TOPIC_MAP: Array<{ topic: string; label: string; keywords: string[] }> = [
  { topic: "motores", label: "Motores Eléctricos", keywords: ["motor", "motores", "ie3", "ie2", "hp", "kw", "rpm", "trifasico", "trifásico", "monofasico", "monofásico", "simotics", "siemens", "innomotics", "1la", "1le", "asíncrono", "asincrono", "induccion", "inducción", "electrico", "eléctrico"] },
  { topic: "variadores", label: "Variadores de Frecuencia", keywords: ["variador", "vfd", "inverter", "g120", "g115", "micromaster", "sinamics", "frecuencia", "arrancador", "soft starter", "drive"] },
  { topic: "contactores", label: "Contactores y Protecciones", keywords: ["contactor", "relé", "rele", "sirius", "3rt", "térmico", "termico", "overload", "protección", "bimetálico"] },
  { topic: "interruptores", label: "Interruptores y Tableros", keywords: ["interruptor", "disyuntor", "breaker", "sentron", "3va", "3vl", "3wl", "diferencial", "tablero", "switchgear"] },
  { topic: "plc", label: "Automatización / PLC", keywords: ["plc", "s7", "simatic", "logo", "cpu", "hmi", "scada", "automatización", "automatizacion", "programación", "programacion"] },
  { topic: "bombas", label: "Bombas y Fluidos", keywords: ["bomba", "bomba de vacío", "vacio", "centrifuga", "caudal", "presión", "fluido", "impeller"] },
  { topic: "cables", label: "Cables y Conexiones", keywords: ["cable", "conductor", "bornera", "bornes", "terminal", "conector", "triflex"] },
  { topic: "transformadores", label: "Transformadores / UPS", keywords: ["transformador", "trafo", "ups", "rectificador", "tensión", "voltaje", "220v", "380v", "440v"] },
  { topic: "cotizacion", label: "Cotización", keywords: ["precio", "cotización", "cotizacion", "presupuesto", "cuánto", "cuanto", "costo", "valor", "oferta"] },
];

function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  return TOPIC_MAP.filter(t => t.keywords.some(k => lower.includes(k))).map(t => t.topic);
}

function roleMatchesTopics(role: { name: string; personality: string; specialties?: string[] | null }, topics: string[]): number {
  if (!topics.length) return 0;
  const roleText = [role.name, role.personality, ...(role.specialties ?? [])].join(" ").toLowerCase();
  return topics.filter(topic => {
    const entry = TOPIC_MAP.find(t => t.topic === topic);
    return entry ? entry.keywords.some(k => roleText.includes(k)) : false;
  }).length;
}

/**
 * Returns true only if content is human-readable text.
 * Rejects raw base64 blobs (dense A-Za-z0-9+/= with no line breaks or commas).
 * NOTE: indexed documents with CSV content pass even with low whitespace ratio.
 */
function isReadableText(content: string): boolean {
  if (!content || content.length < 10) return false;
  if (content.startsWith("data:")) return false;
  const sample = content.substring(0, 400);
  // CSV/structured content: has commas and newlines — always readable
  if (sample.includes(",") && sample.includes("\n")) return true;
  // Base64 blobs: very few spaces/newlines relative to length
  const whitespace = (sample.match(/[\s,\n]/g) || []).length;
  return whitespace / sample.length > 0.02;
}

/**
 * Free-text document search: scores lines by keyword density.
 * Used as fallback for non-price-list documents.
 */
function searchDocumentForTopics(content: string, topics: string[], rawQuery = ""): string | null {
  if (!isReadableText(content)) return null;
  const allLines = content.split(/\n/);
  const lines = allLines.filter(l => l.trim().length > 2 && !l.startsWith("==="));
  if (!lines.length) return null;

  // ── CSV fallback (no structured match found) ────────────────────────────────
  const isCsv = lines.slice(0, 3).some(l => (l.match(/,/g) || []).length >= 2);
  if (isCsv) {
    const header = lines[0];
    const dataLines = lines.slice(1).filter(l => l.trim());
    if (dataLines.length <= 40) return [header, ...dataLines].join("\n");
    return [header, ...dataLines.slice(0, 20)].join("\n");
  }

  // ── Free text mode: score by keyword density ────────────────────────────────
  const topicKeywords = TOPIC_MAP.filter(t => topics.includes(t.topic)).flatMap(t => t.keywords);
  const queryTokens = rawQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const allKw = [...new Set([...topicKeywords, ...queryTokens])];
  const scored = lines.map(line => ({
    line,
    score: allKw.filter(k => line.toLowerCase().includes(k)).length,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, 6).map(s => s.line).join("\n") || null;
}

// ─── Structured price list engine (no external AI required) ──────────────────
// Works like a mini SQL engine: parse CSV → filter rows → format response.

interface MotorQuery {
  hp: number | null;
  kw: number | null;
  poles: number | null;
}

/**
 * Normalizes decimal separators so Spanish format ("1,5") works like English ("1.5").
 * Must be applied before parseFloat.
 */
function normalizeDecimal(s: string): string {
  // Replace comma-decimal only when it appears between digits (not thousands separator)
  return s.replace(/(\d),(\d)/g, "$1.$2");
}

/**
 * Extracts motor specs from natural language conversation text.
 * Handles: "30HP", "30 hp", "1 HP 4 polos", "0.75kw", "1,5 hp", "tetrapolar", etc.
 */
function extractMotorQueryParams(text: string): MotorQuery {
  // Normalize decimal comma BEFORE lowercasing (works for both "1,5 HP" and "1,5 hp")
  const normalized = normalizeDecimal(text);
  const lower = normalized.toLowerCase();

  // HP: "30hp", "30 hp", "de 30 hp", "30 caballos", "1.5 hp", "1,5 hp"
  let hp: number | null = null;
  const hpMatch = lower.match(/(\d+\.?\d*)\s*hp/) ?? lower.match(/(\d+\.?\d*)\s*caball/);
  if (hpMatch) hp = parseFloat(hpMatch[1]);

  // Poles: "4 polos", "4 polo", "tetrapolar", "bipolar"
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
  }

  // kW: "0.75kw", "0.75 kw", "0,75 kw" (used when HP not found)
  let kw: number | null = null;
  const kwMatch = lower.match(/(\d+\.?\d*)\s*kw/);
  if (kwMatch) kw = parseFloat(kwMatch[1]);

  return { hp, kw, poles };
}

/** Returns true if the CSV header looks like a motor/product price list */
function isPriceListCsv(headerLine: string): boolean {
  const h = headerLine.toLowerCase();
  return (h.includes("hp") || h.includes("kw")) &&
    (h.includes("precio") || h.includes("price") || h.includes("usd"));
}

/** Find the first header matching any of the given keyword fragments */
function findCol(headers: string[], ...keywords: string[]): string | null {
  for (const kw of keywords) {
    const found = headers.find(h => h.toLowerCase().includes(kw.toLowerCase()));
    if (found) return found;
  }
  return null;
}

/** Parse CSV text into an array of named-column row objects */
function parsePriceCsv(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("==="));
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).filter(Boolean).map(line => {
    const cols = line.split(",").map(c => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

interface PriceQueryResult {
  headers: string[];
  rows: Record<string, string>[];
  /** Set when the requested HP doesn't exist exactly — contains the closest available */
  nearestHp: number | null;
}

/**
 * Queries a price-list CSV like a database:
 *   1. Filter by HP (or nearest HP if exact not found)
 *   2. Further filter by poles if specified
 * Returns at most 12 rows.
 */
function queryPriceList(content: string, params: MotorQuery): PriceQueryResult {
  const { headers, rows } = parsePriceCsv(content);
  if (!rows.length) return { headers, rows: [], nearestHp: null };

  const hpCol   = findCol(headers, "hp") ?? headers[0];
  const polesCol = findCol(headers, "pol", "polo", "poles");

  // Convert kW to HP if HP not given (1 HP ≈ 0.7457 kW)
  const targetHp = params.hp ?? (params.kw ? parseFloat((params.kw / 0.7457).toFixed(2)) : null);

  let filtered = rows;
  let nearestHp: number | null = null;

  if (targetHp !== null) {
    const exact = rows.filter(r => Math.abs(parseFloat(r[hpCol] ?? "") - targetHp) < 0.01);
    if (exact.length) {
      filtered = exact;
    } else {
      // Find the closest available HP value
      const available = [...new Set(
        rows.map(r => parseFloat(r[hpCol] ?? "0")).filter(v => !isNaN(v) && v > 0)
      )].sort((a, b) => a - b);
      // Guard: if no numeric HP data exists, return empty (fallback to text search)
      if (!available.length) return { headers, rows: [], nearestHp: null };
      const closest = available.reduce(
        (prev, curr) => Math.abs(curr - targetHp) < Math.abs(prev - targetHp) ? curr : prev,
      );
      filtered = rows.filter(r => Math.abs(parseFloat(r[hpCol] ?? "0") - closest) < 0.01);
      nearestHp = closest;
    }
  }

  // Secondary filter: poles
  // If poles were requested but none match, return ZERO rows (not mismatched rows).
  // This prevents quoting the wrong motor spec. The caller falls back to text search.
  if (params.poles !== null && polesCol) {
    const byPoles = filtered.filter(r => parseInt(r[polesCol] ?? "0") === params.poles);
    filtered = byPoles; // empty = no match; caller handles this correctly
  }

  return { headers, rows: filtered.slice(0, 12), nearestHp };
}

/**
 * Formats the price query result as a professional, human-readable WhatsApp response.
 * Never exposes raw CSV — formats each row as readable text.
 */
function formatPriceResponse(
  result: PriceQueryResult,
  params: MotorQuery,
  contactName: string,
): string {
  const { headers, rows, nearestHp } = result;

  if (!rows.length) {
    const spec = params.hp ? `${params.hp} HP` : params.kw ? `${params.kw} kW` : "esas especificaciones";
    return `Estimado ${contactName}, no encontré un motor de ${spec} en nuestro catálogo actual. ` +
      `¿Puede confirmarme la potencia y cantidad de polos que necesita para verificar disponibilidad?`;
  }

  const hpCol    = findCol(headers, "hp")                        ?? headers[0];
  const kwCol    = findCol(headers, "kw");
  const polesCol = findCol(headers, "pol", "polo", "poles");
  const priceCol = findCol(headers, "precio", "price", "usd");

  const requestedHp = params.hp ?? (params.kw ? parseFloat((params.kw / 0.7457).toFixed(2)) : null);
  const approxNote = nearestHp && requestedHp
    ? `\n\n⚠️ No tenemos stock exacto de ${requestedHp} HP. La opción más cercana disponible es ${nearestHp} HP:`
    : "";

  const formatRow = (r: Record<string, string>) => {
    const hp    = r[hpCol]   ?? "–";
    const kw    = kwCol    ? r[kwCol]    : null;
    const poles = polesCol ? r[polesCol] : null;
    const price = priceCol ? r[priceCol] : null;
    let line = `• ${hp} HP`;
    if (kw)    line += ` (${kw} kW)`;
    if (poles) line += ` — ${poles} polos`;
    if (price) line += `: USD ${price}`;
    return line;
  };

  if (rows.length === 1) {
    const r = rows[0];
    const price = priceCol ? r[priceCol] : null;
    let msg = `Estimado ${contactName}, tenemos disponible en nuestro catálogo:${approxNote}\n\n`;
    msg += formatRow(r) + "\n";
    if (price) {
      msg += `\n💰 Precio de lista: USD ${price}\n`;
    }
    msg += `\n¿Le confirmo disponibilidad de stock o necesita algún dato técnico adicional?`;
    return msg;
  }

  // Multiple options (e.g. 30 HP with 2, 4, 6 poles)
  let msg = `Estimado ${contactName}, estas son las opciones disponibles en nuestro catálogo:${approxNote}\n\n`;
  for (const r of rows) {
    msg += formatRow(r) + "\n";
  }
  msg += `\n¿Cuál de estas opciones necesita? También puedo confirmarle stock disponible.`;
  return msg;
}

export async function suggestReply(conversationId: number): Promise<{
  suggestion: string;
  reasoning: string;
  taskSuggestions: string[];
  urgencyLevel: "high" | "medium" | "low";
  matchedRole: string | null;
  docExcerpt: string | null;
  noSpecialist: boolean;
}> {
  try {
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(desc(messagesTable.sentAt))
      .limit(10);

    const inboundMsgs = messages.filter(m => m.direction === "inbound").reverse(); // oldest→newest
    const allText = messages.map(m => m.content).join(" ");

    // Use ONLY the latest inbound message for motor/product query parsing.
    // Concatenating history causes parseMotorQuery to grab HP from a previous message
    // when the user asks for a different motor in a follow-up.
    const lastInboundText = inboundMsgs.at(-1)?.content ?? "";
    // Use full history for topic detection & urgency (richer signal)
    const recentText = inboundMsgs.map(m => m.content).join(" ");

    // Topic detection: prefer last message for specificity, fall back to full
    // history so follow-ups like "¿y precio?" still match the right role.
    const topicsFromLast = detectTopics(lastInboundText);
    const topics = topicsFromLast.length > 0
      ? topicsFromLast
      : detectTopics(recentText || allText);
    const isUrgent = matchKeywords(allText, URGENCY_KEYWORDS);

    // Workspace context — already fetched conv above
    const workspaceId = conv?.workspaceId ?? 1;

    // Find matching active roles
    const activeRoles = await getActiveRoles(workspaceId);
    const scored = activeRoles
      .map(r => ({ role: r, score: roleMatchesTopics(r, topics) }))
      .sort((a, b) => b.score - a.score);

    const bestMatch = scored[0];
    const hasMatch = bestMatch && bestMatch.score > 0;

    const contactName = conv?.contactName ?? "el cliente";
    // queryText for doc search = last message only (specific to this turn)
    const queryText = lastInboundText || recentText || allText;
    // Accent-insensitive normalized form for keyword matching
    const normQuery = queryText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

    // ── CATALOG KB LOOKUP ────────────────────────────────────────────────────────
    // Runs BEFORE role/specialist checks. When the query mentions motor specs
    // (HP/kW/poles), query the static SIMOTICS knowledge base and return
    // immediately if a match is found — even if no specialist role is active.
    // EXCEPTION: if the query is primarily about price/cost, skip the KB and
    // let the price list CSV search handle it (KB has no pricing data).
    // Normalized match: accent-insensitive, covers common Spanish price variants.
    const isPriceQuery = detectPriceIntent(queryText);
    const motorQuery = parseMotorQuery(queryText);
    if (!isPriceQuery && (motorQuery.hp !== null || motorQuery.kw !== null)) {
      const kbResult = lookupMotors(motorQuery);
      if (kbResult.motors.length > 0 && kbResult.source !== "notfound") {
        const policy = await getCatalogPolicy(workspaceId);
        const kbSuggestion = formatCatalogResponse(kbResult, motorQuery, contactName, policy);
        if (kbSuggestion) {
          const kbExcerpt = kbResult.motors
            .map(m => `${m.kw} kW (${m.hp} HP) ${m.poles}P → Frame ${m.frame}`)
            .join("  |  ");
          return {
            suggestion: kbSuggestion,
            reasoning: `Base de conocimiento SIMOTICS GP — ${kbResult.motors.length} motor(es) ${kbResult.source === "nearest" ? `(más cercano: ${kbResult.nearestHp} HP)` : "(exacto)"}`,
            taskSuggestions: ["Verificar código de pedido completo", "Confirmar disponibilidad de stock"],
            urgencyLevel: isUrgent ? "high" : "low",
            matchedRole: hasMatch ? bestMatch.role.name : "Catálogo SIMOTICS GP",
            docExcerpt: kbExcerpt,
            noSpecialist: false,
          };
        }
      }
    }

    // ── BRAND-ONLY MOTOR QUERY ────────────────────────────────────────────────────
    // "¿Tenés motores Siemens?" — brand/availability question without HP/kW specs.
    // Return a coherent brand-aware response and invite specs, instead of
    // falling through to an empty doc search.
    const BRAND_KEYWORDS = ["siemens", "simotics", "innomotics", "sinamics"];
    // Require explicit motor term in the query to avoid false-positives from topic
    // classification alone (e.g. "trabajan con Siemens?" should not trigger this path)
    const MOTOR_TERMS = ["motor", "motores", "simotics"];
    const isBrandMotorQuery = topics.includes("motores")
      && BRAND_KEYWORDS.some(b => normQuery.includes(b))
      && MOTOR_TERMS.some(t => normQuery.includes(t))
      && motorQuery.hp === null
      && motorQuery.kw === null
      && motorQuery.poles === null;  // exclude poles-only queries that already have a spec

    if (isBrandMotorQuery) {
      return {
        suggestion:
          `Estimado ${contactName}, sí — somos distribuidores oficiales de **motores eléctricos SIMOTICS GP de Siemens (Innomotics)**.\n\n` +
          `Trabajamos con toda la gama trifásica IE3 en baja tensión:\n` +
          `• Potencias de 0,25 HP a 340 HP\n` +
          `• 2, 4, 6 y 8 polos (900 a 3600 rpm)\n` +
          `• Montajes B3, B5, B14, B34 y B35\n` +
          `• Eficiencia IE3 — IP55 / Clase F\n\n` +
          `¿Cuál es la potencia y cantidad de polos que necesita? Con esos datos le doy ficha técnica completa y precio de lista.`,
        reasoning: "Consulta de marca/disponibilidad — respuesta orientada a catálogo SIMOTICS GP",
        taskSuggestions: ["Identificar requerimiento técnico del cliente"],
        urgencyLevel: isUrgent ? "high" : "low",
        matchedRole: hasMatch ? bestMatch.role.name : "Catálogo SIMOTICS GP",
        docExcerpt: "0,25–340 HP | 2/4/6/8 polos | IE3 | IP55 | B3/B5/B14",
        noSpecialist: false,
      };
    }

    // If no active role covers the topic (and KB didn't answer it), show hint
    if (!hasMatch && topics.length > 0) {
      const topicLabels = topics.map(t => TOPIC_MAP.find(m => m.topic === t)?.label ?? t).join(", ");
      return {
        suggestion: "",
        reasoning: `No hay ningún especialista activo configurado para el tema: ${topicLabels}. Activá el rol correspondiente en Configuración → Roles IA.`,
        taskSuggestions: [],
        urgencyLevel: isUrgent ? "high" : "medium",
        matchedRole: null,
        docExcerpt: null,
        noSpecialist: true,
      };
    }

    // Search role documents for relevant content
    let docExcerpt: string | null = null;
    let suggestion = "";
    let docSource = "";

    if (hasMatch) {
      const docs = await db
        .select({ content: documentsTable.content, name: documentsTable.name })
        .from(roleDocumentsTable)
        .innerJoin(documentsTable, eq(roleDocumentsTable.documentId, documentsTable.id))
        .where(and(eq(roleDocumentsTable.roleId, bestMatch.role.id), eq(documentsTable.indexed, true)));

      const topicLabel = topics.length ? TOPIC_MAP.find(t => t.topic === topics[0])?.label ?? topics[0] : "su consulta";

      for (const doc of docs) {
        const content = doc.content ?? "";
        if (!isReadableText(content)) continue;

        // ── Structured price list search (acts like SQL, no LLM needed) ──────
        // Detects HP/kW/poles in the conversation, queries the CSV as a DB,
        // and formats the result as a readable response — never dumps raw CSV.
        const firstDataLine = content.split("\n").find(l => l.trim() && !l.startsWith("===")) ?? "";
        if (isPriceListCsv(firstDataLine)) {
          const motorParams = extractMotorQueryParams(queryText);

          if (motorParams.hp !== null || motorParams.kw !== null || motorParams.poles !== null) {
            // Specs known → structured lookup
            const result = queryPriceList(content, motorParams);
            if (result.rows.length) {
              suggestion = formatPriceResponse(result, motorParams, contactName);
              const hpCol    = findCol(result.headers, "hp")              ?? result.headers[0];
              const priceCol = findCol(result.headers, "precio", "price", "usd");
              docExcerpt = result.rows
                .map(r => `${r[hpCol]} HP → USD ${priceCol ? r[priceCol] : "–"}`)
                .join("  |  ");
              docSource = doc.name;
              break;
            } else {
              // Specs given but not found in the list
              const hpLabel = motorParams.hp != null ? `${motorParams.hp} HP` : `${motorParams.kw} kW`;
              const polesLabel = motorParams.poles ? `, ${motorParams.poles} polos` : "";
              suggestion = `Estimado ${contactName}, no encontré ${hpLabel}${polesLabel} en nuestra lista de precios actualizada.\n\n¿Desea que verifiquemos disponibilidad bajo pedido o le ofrecemos la opción más cercana disponible?`;
              docSource = doc.name;
              break;
            }
          } else {
            // No HP/kW/poles detected. Branch on intent:
            if (isPriceQuery) {
              // User wants a price but didn't specify specs → ask for them
              suggestion = `Estimado ${contactName}, con gusto le informo el precio de nuestra lista.\n\n` +
                `¿Podría indicarme la **potencia** (HP o kW) y la **cantidad de polos** que necesita?\n` +
                `Por ejemplo: _"1 HP 4 polos"_ o _"0,75 kW 6 polos"_.\n\n` +
                `Con esos datos le doy el precio exacto y disponibilidad.`;
              docSource = doc.name;
            }
            // Either way, never let raw CSV rows fall through to the keyword search
            // or get embedded in the generic template — skip to the next document.
            // If this was a non-price/non-spec query against a CSV-only role,
            // the outer "no suggestion" block will produce a professional generic reply.
            continue;
          }
        }

        // ── Full-text / keyword fallback (only for non-CSV documents) ─────────
        const excerpt = searchDocumentForTopics(content, topics, queryText);
        if (excerpt) {
          docExcerpt = excerpt.substring(0, 800);
          docSource = doc.name;
          break;
        }
      }

      // Generic template only when structured search didn't produce a suggestion
      if (!suggestion) {
        if (docExcerpt) {
          suggestion = `Estimado ${contactName}, gracias por su consulta sobre ${topicLabel}.\n\n` +
            `Según nuestra información disponible:\n${docExcerpt}\n\n` +
            `Por favor, confirmame si esta información responde a lo que necesitás o si querés que profundice en algún punto.`;
        } else {
          suggestion = `Estimado ${contactName}, gracias por su consulta sobre ${topicLabel}.\n\n` +
            `Estamos verificando disponibilidad y condiciones para esta solicitud. Le confirmo en breve con la información exacta.\n\n` +
            `¿Tiene algún requerimiento técnico específico que deba considerar?`;
        }
      }
    } else {
      // No topic detected — generic professional response
      suggestion = `Estimado ${contactName}, gracias por comunicarse con Cruzzolin Materiales Eléctricos.\n\nRecibimos su consulta y le responderemos a la brevedad con la información que necesita. ¿Puede indicarnos más detalles sobre su requerimiento?`;
    }

    const taskSuggestions = topics.includes("cotizacion") || matchKeywords(allText, QUOTE_KEYWORDS)
      ? ["Preparar cotización formal", "Verificar stock disponible"]
      : isUrgent ? ["Contactar cliente urgente", "Verificar disponibilidad inmediata"] : [];

    return {
      suggestion,
      reasoning: hasMatch
        ? `Rol activo: ${bestMatch.role.name}${docExcerpt ? ` — fragmento encontrado en "${docSource}"` : " — sin documentos cargados para este tema"}`
        : "Respuesta genérica profesional (ningún rol activo coincide con el tema detectado).",
      taskSuggestions,
      urgencyLevel: isUrgent ? "high" : topics.includes("cotizacion") ? "medium" : "low",
      matchedRole: hasMatch ? bestMatch.role.name : null,
      docExcerpt,
      noSpecialist: false,
    };
  } catch (e) {
    logger.error({ err: e }, "suggestReply failed");
    return {
      suggestion: "Gracias por su consulta. Le respondo en breve con la información disponible.",
      reasoning: "Error al procesar la sugerencia.",
      taskSuggestions: [],
      urgencyLevel: "medium",
      matchedRole: null,
      docExcerpt: null,
      noSpecialist: false,
    };
  }
}

// ─── Local heuristic analyzer (no API key required) ─────────────────────────

const PRODUCT_KEYWORDS: Record<string, string[]> = {
  motor: ["motor", "motores", "ie3", "ie2", "hp", "kw", "rpm", "trifásico", "monofásico", "simotics", "1la", "1le"],
  variador: ["variador", "vfd", "inverter", "g120", "g115", "micromaster", "sinamics", "arrancador", "soft starter"],
  contactor: ["contactor", "relé", "rele", "sirius", "3rt", "térmico", "termico", "overload"],
  interruptor: ["interruptor", "disyuntor", "breaker", "sentron", "3va", "3vl", "3wl", "diferencial", "termica"],
  plc: ["plc", "s7", "simatic", "logo", "cpu", "hmi", "scada", "automatización", "automatizacion"],
  cable: ["cable", "conductor", "bornera", "bornes", "terminal", "conector"],
  transformador: ["transformador", "trafo", "ups", "rectificador"],
  sensor: ["sensor", "encoder", "transductor", "pt100", "termocupla"],
};

const URGENCY_KEYWORDS = [
  "urgente", "urgencia", "emergencia", "inmediato", "hoy", "ahora", "ya", "rápido", "rapido",
  "parada", "detenido", "falla", "avería", "averia",
  // Industrial-specific urgency terms
  "planta parada", "producción detenida", "produccion detenida",
  "máquina quemada", "maquina quemada", "equipo quemado",
  "urgente inmediato", "horno apagado", "horno parado",
  "línea parada", "linea parada", "proceso detenido",
  "sin producción", "sin produccion", "fuera de servicio",
  "quemado", "cortocircuito", "se fundió", "se fundio",
];
const QUOTE_KEYWORDS = [
  "cotización", "cotizacion", "precio", "cuánto", "cuanto", "valor", "presupuesto", "oferta", "costo",
  // Industrial/local commercial terms
  "lista de precios", "precio de lista", "lista precio",
  "importe", "a cuánto", "a cuanto", "precio unitario",
  "precio final", "precio neto", "precio con iva",
  "cuánto me sale", "cuanto me sale", "cuánto sale", "cuanto sale",
];
const PURCHASE_KEYWORDS = ["comprar", "compra", "pedido", "orden", "factura", "pagar", "transferencia", "confirmado", "adelante", "lo tomo"];
const COMPLAINT_KEYWORDS = ["reclamo", "problema", "falla", "incorrecto", "mal", "error", "defecto", "no funciona", "roto"];
const SUPPORT_KEYWORDS = [
  "manual", "soporte", "técnico", "tecnico", "instalación", "instalacion", "configurar", "parametro", "parámetro", "conectar", "cómo", "como",
  // Industrial technical documentation terms
  "ficha técnica", "ficha tecnica", "datasheet", "hoja de datos",
  "curva característica", "curva caracteristica", "curva de par",
  "tabla de selección", "tabla de seleccion",
  "catálogo", "catalogo", "especificación técnica", "especificacion tecnica",
  "plano", "esquema", "diagrama de conexión", "diagrama de conexion",
  "manual de instalación", "manual de instalacion",
  "protocolo", "certificado", "norma iec", "norma nema",
];
const NEGOTIATION_KEYWORDS = ["descuento", "negociar", "rebaja", "mejor precio", "competencia", "otro proveedor", "más barato", "mas barato"];
const FOLLOW_UP_KEYWORDS = ["esperando", "espero", "cuando", "cuándo", "confirmación", "confirmacion", "novedad", "noticias", "saber"];

// Commercial-signal keywords — an inbound OR outbound message containing any of
// these triggers automatic opportunity creation/update.
const OPPORTUNITY_SIGNAL_KEYWORDS = [
  "cotización", "cotizacion", "precio", "presupuesto", "stock", "disponibilidad",
  "disponible", "pedido", "orden de compra", "comprar", "necesito", "urgente",
  // Outbound / operator-side quote signals
  "te cotizo", "te paso precio", "te paso presupuesto", "te envío cotización",
  "te envio cotizacion", "importe", "neto", "con iva", "precio final",
  "dólares", "dolares", "usd", "oferta", "descuento",
];

/**
 * Returns "high" when the message contains strong commercial intent (quote request,
 * purchase, negotiation, or a price amount), "medium" for softer signals,
 * and "low" for generic keyword hits with no real commercial context.
 * Low-confidence messages are skipped — they would generate too many false positives.
 */
/**
 * Normalizes an Argentine / international number string to a plain float.
 * "1.200,50" → 1200.50  |  "1,200.50" → 1200.50  |  "1.200" → 1200  |  "1200" → 1200
 */
function normalizeNumericString(raw: string): number {
  let normalized = raw;
  if (raw.includes(",") && raw.includes(".")) {
    if (raw.lastIndexOf(",") > raw.lastIndexOf(".")) {
      // Argentine: 1.200,50
      normalized = raw.replace(/\./g, "").replace(",", ".");
    } else {
      // International: 1,200.50
      normalized = raw.replace(/,/g, "");
    }
  } else if (raw.includes(",")) {
    const afterComma = raw.split(",")[1] ?? "";
    normalized = afterComma.length <= 2
      ? raw.replace(",", ".")   // decimal comma: 0,50 → 0.50
      : raw.replace(/,/g, "");  // thousands comma: 1,200 → 1200
  } else if (raw.includes(".")) {
    const afterDot = raw.split(".")[1] ?? "";
    if (afterDot.length === 3) normalized = raw.replace(/\./g, ""); // 1.200 → 1200
  }
  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val;
}

/**
 * Extracts the first recognizable price amount from a text.
 * Handles both "USD 1200" and "1200 USD", "$1.200", "U$S 500",
 * "1200 dolares/dólares", "5.000 pesos". Argentine number notation supported.
 * Returns 0 when no price is found.
 */
export function extractPriceFromText(text: string): number {
  // Each pattern: [regex, capture-group-index-for-the-number-string]
  const patterns: RegExp[] = [
    /\$\s*([\d.,]+)/,                                          // $1.200 · $ 45.000
    /\bU\$S\s*([\d.,]+)/i,                                     // U$S 500
    /\bUSD\s*([\d.,]+)/i,                                      // USD 1200 (currency before number)
    /\b([\d.,]+)\s*USD\b/i,                                    // 1200 USD
    /\b([\d.,]+)\s*d[oó]lares?\b/i,                            // 1200 dolares · dólares
    /\b([\d.,]+)\s*pesos?\b/i,                                  // 1200 pesos
    // ── Negotiation-context bare numbers (no explicit currency marker) ───────
    // "llevo a 1350", "lo llevo a 1350 confirmo"
    /\bllevo\s+a\s+([\d.,]+)/i,
    // "se va a 1350 confirmas", "el precio se va a 1350"
    /\bse\s+va\s+a\s+([\d.,]+)/i,
    // "vale 1350", "ahora vale 1350"
    /\bvale\s+([\d.,]+)/i,
    // "a 1350 confirmo/confirmas/confirmado"
    /\ba\s+([\d.,]+)\s+confirma(?:s|do|r)?\b/i,
    // "queda en 1350", "cerramos en 1350"
    /\ben\s+([\d.,]+)\s+(?:cerramos?|lo\s+dejo|quedamos?|lo\s+tomo|lo\s+llevo)\b/i,
    // "el precio es 1350", "sale 1350"
    /\b(?:precio\s+es|sale|cuesta|cobro)\s+([\d.,]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    // Group 1 is always the numeric capture
    const val = normalizeNumericString(m[1]);
    // Sanity: ignore unrealistically tiny values (< 1) or huge ones (> 100M)
    if (val >= 1 && val <= 100_000_000) return val;
  }
  return 0;
}

/**
 * Scans the most recent messages of a conversation (newest first) and returns
 * the most recently mentioned price. Falls back to 0 if none found.
 * Used to keep Pipeline opportunity values in sync with price negotiations.
 */
async function extractLatestPriceFromConversation(conversationId: number, limit = 30): Promise<number> {
  try {
    const msgs = await db
      .select({ content: messagesTable.content })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.conversationId, conversationId),
        // Only text messages can carry a price
        inArray(messagesTable.mediaType, ["text", "extended_text"]),
      ))
      .orderBy(desc(messagesTable.sentAt))
      .limit(limit);

    for (const msg of msgs) {
      if (!msg.content) continue;
      const val = extractPriceFromText(msg.content);
      if (val > 0) return val;
    }
  } catch (e) {
    logger.warn({ err: e, conversationId }, "extractLatestPriceFromConversation failed");
  }
  return 0;
}

function commercialConfidence(text: string): "high" | "medium" | "low" {
  const intent = detectIntent(text);
  if (intent === "quote_request" || intent === "purchase" || intent === "negotiation") return "high";
  // Price amounts: $45.000 · USD 320 · U$S 500 · $ 1.200,50
  if (/\$\s*[\d.,]+|\bUSD\s*[\d.,]+|\bU\$S\s*[\d.,]+/i.test(text)) return "high";
  // QUOTE_KEYWORDS already covers "presupuesto", "precio", "cotización", etc.
  if (matchKeywords(text, QUOTE_KEYWORDS) || matchKeywords(text, PURCHASE_KEYWORDS)) return "medium";
  return "low";
}

/**
 * Automatic opportunity creation/update.
 *
 * Rules (per product spec):
 *  • Works for both inbound and outbound messages.
 *  • Low-confidence detections are skipped (no false positives).
 *  • If an open opportunity already exists for this conversation → log activity, don't duplicate.
 *  • If an open opportunity exists for the client (different conv) → same: log, don't duplicate.
 *  • Stage is "quote" when the operator is sending a cotización outbound; "prospect" otherwise.
 *  • Origin: "Detectado automáticamente por IA desde conversación".
 */
export async function maybeCreateOpportunityFromMessage(
  clientId: number,
  messageText: string,
  contactName: string,
  workspaceId: number,
  conversationId?: number,
  direction: "inbound" | "outbound" = "inbound",
  minConfidence: "medium" | "high" = "medium",
) {
  try {
    // ── Confidence gate — skip weak signals ───────────────────────────────────
    const confidence = commercialConfidence(messageText);
    if (confidence === "low" && !matchKeywords(messageText, OPPORTUNITY_SIGNAL_KEYWORDS)) return;
    // Pure keyword match with no real commercial context → still skip
    if (confidence === "low") return;
    // Respect minimum confidence setting: if operator requires "high", skip medium signals
    if (minConfidence === "high" && confidence !== "high") return;

    const { opportunitiesTable } = await import("@workspace/db");
    const { logClientEvent } = await import("./clientEvents");
    const OPEN_STAGES = ["prospect", "first_contact", "quote", "negotiation", "waiting_decision"];

    // ── Dedup: conversation-level first, then client-level ────────────────────
    let existing: { id: number; title: string; value: number } | undefined;

    if (conversationId) {
      const [byConv] = await db
        .select({ id: opportunitiesTable.id, title: opportunitiesTable.title, value: opportunitiesTable.value })
        .from(opportunitiesTable)
        .where(and(
          eq(opportunitiesTable.workspaceId, workspaceId),
          eq((opportunitiesTable as any).conversationId, conversationId),
          inArray(opportunitiesTable.stage, OPEN_STAGES),
        ))
        .limit(1);
      existing = byConv;
    }

    if (!existing) {
      const [byClient] = await db
        .select({ id: opportunitiesTable.id, title: opportunitiesTable.title, value: opportunitiesTable.value })
        .from(opportunitiesTable)
        .where(and(
          eq(opportunitiesTable.clientId, clientId),
          inArray(opportunitiesTable.stage, OPEN_STAGES),
        ))
        .limit(1);
      existing = byClient;
    }

    // ── Resolve the best known price for this conversation ───────────────────
    // Scan the full conversation history (newest first) so negotiations are
    // reflected immediately — e.g. "5000 dolares" followed by "1200 dolares"
    // ends up at 1200. Fall back to whatever is in the current message.
    const conversationPrice = conversationId
      ? await extractLatestPriceFromConversation(conversationId)
      : extractPriceFromText(messageText);
    const bestPrice = conversationPrice > 0 ? conversationPrice : extractPriceFromText(messageText);

    // ── Already exists → update value if price changed; log activity ──────────
    if (existing) {
      const currentValue = existing.value ?? 0;
      const valueChanged = bestPrice > 0 && Math.abs(bestPrice - currentValue) > 0.01;
      if (valueChanged) {
        await db
          .update(opportunitiesTable)
          .set({ value: bestPrice })
          .where(eq(opportunitiesTable.id, existing.id));
        logger.info({ opportunityId: existing.id, oldValue: currentValue, newValue: bestPrice }, "Auto-opp: value updated from conversation history");
      }
      const detail = valueChanged
        ? `Precio actualizado a $${bestPrice.toLocaleString("es-AR")} — oportunidad "${existing.title}" actualizada`
        : `Nueva señal comercial en conversación — oportunidad "${existing.title}" actualizada`;
      await logClientEvent({
        workspaceId,
        clientId,
        type: "opportunity_updated",
        detail,
        actor: "IA",
        relatedType: "opportunity",
        relatedId: existing.id,
      });
      logger.info({ opportunityId: existing.id, conversationId, direction }, "Auto-opp: existing opportunity updated with new signal");
      return;
    }

    // ── Create new opportunity ────────────────────────────────────────────────
    const products = detectProducts(messageText);
    const title = products.length
      ? `Consulta de ${products.join(", ")} — ${contactName}`
      : direction === "outbound"
        ? `Cotización enviada — ${contactName}`
        : `Nueva consulta comercial — ${contactName}`;

    // Outbound: operator sent a quote → jump to "quote" stage; inbound: start at "prospect"
    const stage = direction === "outbound" && confidence === "high" ? "quote" : "prospect";
    const probability = stage === "quote" ? 45 : 30;

    // Use the best price extracted from conversation history
    const extractedValue = bestPrice;

    const [opp] = await db.insert(opportunitiesTable).values({
      workspaceId,
      title,
      clientId,
      ...(conversationId ? { conversationId } : {}),
      stage,
      value: extractedValue,
      probability,
      product: products[0] ?? null,
      description: `Detectado automáticamente por IA desde conversación (${direction === "outbound" ? "mensaje enviado" : "mensaje recibido"}): "${messageText.slice(0, 200)}"`,
      source: "ai_auto",
    } as any).returning({ id: opportunitiesTable.id, title: opportunitiesTable.title });

    await logClientEvent({
      workspaceId,
      clientId,
      type: "opportunity_created",
      detail: `Oportunidad creada automáticamente por IA: ${opp.title}`,
      actor: "IA",
      relatedType: "opportunity",
      relatedId: opp.id,
    });

    logger.info({ opportunityId: opp.id, conversationId, clientId, direction, confidence }, "Auto-opp: opportunity created");
  } catch (e) {
    logger.warn({ err: e, clientId, conversationId }, "Auto-opportunity creation failed");
  }
}

type TagAutomation = { urgent: boolean; awaiting_quote: boolean; complaint: boolean; resolved: boolean };
const DEFAULT_TAG_AUTOMATION: TagAutomation = { urgent: true, awaiting_quote: true, complaint: true, resolved: true };

/** Reads the per-tag automation toggles from Sistema settings; missing keys default to enabled. */
export async function getTagAutomation(workspaceId?: number): Promise<TagAutomation> {
  try {
    const query = db.select({ tagAutomation: aiSettingsTable.tagAutomation }).from(aiSettingsTable);
    const [row] = workspaceId !== undefined
      ? await query.where(eq(aiSettingsTable.workspaceId, workspaceId)).limit(1)
      : await query.limit(1);
    const stored = (row?.tagAutomation ?? {}) as Partial<TagAutomation>;
    return { ...DEFAULT_TAG_AUTOMATION, ...stored };
  } catch (e) {
    logger.warn({ err: e }, "getTagAutomation failed, defaulting to all enabled");
    return DEFAULT_TAG_AUTOMATION;
  }
}

function matchKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k)).length;
}

/**
 * Detects industrial part numbers / product codes in a message.
 * Covers Siemens/Innomotics article numbers (e.g. 1LA7083-4AA10, 6ES7214-1AG40-0XB0),
 * generic alphanumeric codes with dashes (e.g. ABC-1234, A1B2-C3), and
 * standalone numeric catalog codes (4+ digits isolated by word boundaries).
 * Returns true when at least one plausible code is found.
 */
function detectPartNumber(text: string): boolean {
  // Siemens-style: letter(s)+digits + dash + mix of letters and digits (e.g. 1LA7083-4AA10)
  const siemensPattern = /\b[0-9][A-Z]{1,3}[0-9]{3,5}-[0-9][A-Z]{1,3}[0-9]{1,5}(-[0-9A-Z]{2,6})?\b/i;
  // Generic alphanumeric code: at least one letter AND one digit, separated by dash(es), 6+ chars total
  const genericPattern = /\b(?=[A-Z0-9-]{6,})(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*[0-9])[A-Z0-9]+(?:-[A-Z0-9]+){1,}\b/i;
  // Standalone 4–8 digit catalog number (word-boundary isolated, not a year 19xx/20xx)
  const numericPattern = /\b(?!(?:19|20)\d{2}\b)\d{4,8}\b/;
  return siemensPattern.test(text) || genericPattern.test(text) || numericPattern.test(text);
}

function detectProducts(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(PRODUCT_KEYWORDS)
    .filter(([, kws]) => kws.some(k => lower.includes(k)))
    .map(([cat]) => cat);
}

// Client como fuente de información automática: cada conversación deja
// rastro en el perfil del cliente (productos consultados, etiquetas de
// interacción), no solo en la conversación puntual. Nunca pisa datos que
// el operador ya cargó a mano — solo agrega/mergea, nunca reemplaza.
async function accumulateClientKnowledge(clientId: number, opts: { products?: string[]; interactionTag?: string }) {
  try {
    const [client] = await db.select({
      consultedProducts: clientsTable.consultedProducts,
      tags: clientsTable.tags,
    }).from(clientsTable).where(eq(clientsTable.id, clientId));
    if (!client) return;

    const update: Record<string, unknown> = {};

    if (opts.products?.length) {
      const merged = Array.from(new Set([...(client.consultedProducts ?? []), ...opts.products]));
      if (merged.length !== (client.consultedProducts ?? []).length) {
        update.consultedProducts = merged;
      }
    }
    if (opts.interactionTag) {
      const existing = client.tags ?? [];
      if (!existing.includes(opts.interactionTag)) {
        update.tags = [...existing, opts.interactionTag];
      }
    }

    if (Object.keys(update).length) {
      await db.update(clientsTable).set(update).where(eq(clientsTable.id, clientId));
    }
  } catch (e) {
    logger.warn({ err: e, clientId }, "accumulateClientKnowledge failed");
  }
}

function detectIntent(allText: string): "inquiry" | "quote_request" | "complaint" | "purchase" | "support" | "negotiation" | "follow_up" | "other" {
  const scores: Record<string, number> = {
    purchase: countMatches(allText, PURCHASE_KEYWORDS) * 3,
    // Part-number mention in a message is a strong quote/inquiry signal (+2)
    quote_request: countMatches(allText, QUOTE_KEYWORDS) * 2 + (detectPartNumber(allText) ? 2 : 0),
    complaint: countMatches(allText, COMPLAINT_KEYWORDS) * 2,
    negotiation: countMatches(allText, NEGOTIATION_KEYWORDS) * 2,
    support: countMatches(allText, SUPPORT_KEYWORDS),
    follow_up: countMatches(allText, FOLLOW_UP_KEYWORDS),
    inquiry: 1, // base
  };
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[0] as ReturnType<typeof detectIntent>;
}

function detectStatus(allText: string, lastDirection: "inbound" | "outbound", intent: string): string {
  if (matchKeywords(allText, URGENCY_KEYWORDS)) return "urgent";
  if (matchKeywords(allText, COMPLAINT_KEYWORDS)) return "complaint";
  if (intent === "purchase" && matchKeywords(allText, ["confirmado", "adelante", "lo tomo", "factura"])) return "sale_closed";
  if (intent === "quote_request") return "awaiting_quote";
  if (lastDirection === "outbound") return "awaiting_client";
  if (matchKeywords(allText, FOLLOW_UP_KEYWORDS)) return "follow_up";
  return "waiting_reply";
}

function detectClientClass(inboundMsgs: number, products: string[], allText: string): "A" | "B" | "C" {
  let score = 0;
  score += Math.min(inboundMsgs * 2, 10);
  score += products.length * 3;
  if (matchKeywords(allText, PURCHASE_KEYWORDS)) score += 8;
  if (matchKeywords(allText, ["planta", "fábrica", "fabrica", "producción", "produccion", "industria"])) score += 5;
  if (matchKeywords(allText, URGENCY_KEYWORDS)) score += 4;
  if (matchKeywords(allText, QUOTE_KEYWORDS)) score += 3;
  if (score >= 18) return "A";
  if (score >= 8) return "B";
  return "C";
}

function buildSummary(
  contactName: string,
  intent: string,
  products: string[],
  isUrgent: boolean,
  inboundCount: number,
  outboundCount: number,
  lastInbound: string,
  status: string,
): string {
  const intentLabels: Record<string, string> = {
    quote_request: "solicita una cotización",
    purchase: "quiere concretar una compra",
    complaint: "tiene un reclamo o problema",
    support: "necesita soporte técnico",
    negotiation: "está negociando condiciones",
    follow_up: "aguarda novedades",
    inquiry: "realiza una consulta",
    other: "tiene una consulta general",
  };

  const productList = products.length ? products.join(", ") : "equipos eléctricos";
  const urgencyNote = isUrgent ? " con carácter urgente" : "";
  const preview = lastInbound.length > 80 ? lastInbound.slice(0, 77) + "…" : lastInbound;

  let summary = `${contactName} ${intentLabels[intent] || "consulta"}${urgencyNote} sobre ${productList}.`;
  summary += ` Intercambio de ${inboundCount + outboundCount} mensajes (${inboundCount} del cliente, ${outboundCount} nuestros).`;
  if (preview) summary += ` Último mensaje: "${preview}".`;

  return summary;
}

function suggestTasks(
  intent: string,
  products: string[],
  isUrgent: boolean,
  contactName: string,
  allText: string,
): Array<{ title: string; priority: "high" | "medium" | "low"; type: string }> {
  const tasks: Array<{ title: string; priority: "high" | "medium" | "low"; type: string }> = [];
  const priority: "high" | "medium" | "low" = isUrgent ? "high" : intent === "purchase" || intent === "quote_request" ? "medium" : "low";

  if (intent === "quote_request" || matchKeywords(allText, QUOTE_KEYWORDS)) {
    tasks.push({ title: `Enviar cotización a ${contactName}`, priority: isUrgent ? "high" : "medium", type: "send_quote" });
  }
  if (matchKeywords(allText, ["stock", "disponible", "disponibilidad", "tenés", "tienen"])) {
    tasks.push({ title: `Consultar stock de ${products[0] || "producto"} para ${contactName}`, priority, type: "consult_stock" });
  }
  if (matchKeywords(allText, ["fábrica", "fabrica", "plazo", "importación", "importacion", "lead time"])) {
    tasks.push({ title: `Consultar a fábrica disponibilidad para ${contactName}`, priority, type: "consult_factory" });
  }
  if (intent === "complaint") {
    tasks.push({ title: `Resolver reclamo de ${contactName}`, priority: "high", type: "call_client" });
  }
  if (intent === "purchase") {
    tasks.push({ title: `Enviar factura/proforma a ${contactName}`, priority: "high", type: "send_invoice" });
  }
  if (intent === "support") {
    tasks.push({ title: `Enviar manual/soporte a ${contactName}`, priority, type: "send_catalog" });
  }
  if (tasks.length === 0) {
    tasks.push({ title: `Hacer seguimiento con ${contactName}`, priority: "low", type: "other" });
  }
  return tasks.slice(0, 3);
}

export async function analyzeConversation(conversationId: number) {
  try {
    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(desc(messagesTable.sentAt))
      .limit(30);

    if (!messages.length) {
      return { summary: "Sin mensajes para analizar.", intent: "inquiry", status: "unclassified", tasksCreated: [], clientClassification: null };
    }

    const reversed = [...messages].reverse();
    const inbound = reversed.filter(m => m.direction === "inbound");
    const outbound = reversed.filter(m => m.direction === "outbound");
    const allText = reversed.map(m => m.content).join(" ");
    const lastInbound = inbound[inbound.length - 1]?.content || "";
    const lastMsg = reversed[reversed.length - 1];

    const products = detectProducts(allText);
    const intent = detectIntent(allText);
    const isUrgent = matchKeywords(allText, URGENCY_KEYWORDS);
    const status = detectStatus(allText, (lastMsg?.direction ?? "inbound") as "inbound" | "outbound", intent);
    const clientClass = detectClientClass(inbound.length, products, allText);
    // Prefer the linked client's name so AI-generated task titles show
    // the real contact name instead of a raw phone number.
    let contactName = conv?.contactName || "Cliente";
    if (conv?.clientId) {
      const [cl] = await db.select({ name: clientsTable.name }).from(clientsTable)
        .where(eq(clientsTable.id, conv.clientId));
      if (cl?.name) contactName = cl.name;
    }

    const summary = buildSummary(contactName, intent, products, isUrgent, inbound.length, outbound.length, lastInbound, status);
    const tasks = suggestTasks(intent, products, isUrgent, contactName, allText);

    // Map heuristic status to the 4 canonical DB values (active/waiting/resolved/archived)
    const canonicalStatus: Record<string, string> = {
      urgent: "active",
      complaint: "active",
      waiting_reply: "waiting",
      awaiting_client: "waiting",
      awaiting_quote: "waiting",
      awaiting_approval: "waiting",
      awaiting_factory: "waiting",
      follow_up: "waiting",
      sale_closed: "resolved",
      inactive: "archived",
    };
    const dbStatus = canonicalStatus[status] ?? "active";

    // Persist summary + canonical status only
    await db
      .update(conversationsTable)
      .set({ aiSummary: summary, status: dbStatus })
      .where(eq(conversationsTable.id, conversationId));

    // Return tasks for the route to insert (avoids double-write)
    return { summary, intent, status, tasksCreated: tasks, clientClassification: clientClass };
  } catch (e) {
    logger.error({ err: e }, "analyzeConversation failed");
    return { summary: "Error al analizar.", intent: "inquiry", status: "unclassified", tasksCreated: [], clientClassification: null };
  }
}

// ─── Deep LLM-powered analysis (Analizar button) ─────────────────────────────

function fmtDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
function fmtTime(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface DeepAnalysis {
  /** What kind of action the AI recommends */
  actionType: "task" | "calendar_event" | "info_only";
  /** Free-text recommendation returned when actionType === "info_only" */
  recommendation?: string;
  nextAction: string;
  suggestedDate: string | null;
  /** ISO datetime string (YYYY-MM-DDTHH:mm) when actionType === "calendar_event" */
  suggestedDateTime?: string | null;
  closeProbability: "alta" | "media" | "baja";
  risks: string[];
  nextStep: string;
  task: {
    title: string;
    description: string;
    dueAt: string | null;
    priority: "high" | "medium" | "low";
    type: string;
    motif: string;
  } | null;
  explanation: string;
  summary: string;
  intent: string;
  clientClassification: string | null;
}

/**
 * Full LLM-powered commercial intelligence analysis — called by the Analizar button.
 * Returns a rich panel with next action, risks, close probability, and a pre-filled task.
 * Does NOT create tasks (the route handles that on user confirmation).
 *
 * @param conversationId  The conversation to analyse.
 * @param visibleMessages Optional subset of messages currently visible in the UI.
 *                        When provided the analysis focuses only on these messages.
 */
export async function analyzeConversationDeep(
  conversationId: number,
  visibleMessages?: { id: number; content: string; direction: string; sentAt: string }[],
): Promise<DeepAnalysis> {
  const [conv] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId));

  let contactName = conv?.contactName || "Cliente";
  if (conv?.clientId) {
    const [cl] = await db.select({ name: clientsTable.name }).from(clientsTable)
      .where(eq(clientsTable.id, conv.clientId));
    if (cl?.name) contactName = cl.name;
  }

  // When specific visible messages are supplied, use them; otherwise fall back to last 40.
  let rawMessages: { id: number; content: string | null; direction: string | null; sentAt: Date | null; conversationId: number | null }[];
  if (visibleMessages && visibleMessages.length > 0) {
    rawMessages = visibleMessages.map(m => ({
      id: m.id,
      content: m.content,
      direction: m.direction,
      sentAt: m.sentAt ? new Date(m.sentAt) : null,
      conversationId,
    }));
  } else {
    rawMessages = await db.select().from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(desc(messagesTable.sentAt))
      .limit(40);
    rawMessages = [...rawMessages].reverse(); // chronological
  }

  const allText = rawMessages.map(m => m.content).join(" ");
  const intent = detectIntent(allText);
  const products = detectProducts(allText);
  const clientClass = detectClientClass(
    rawMessages.filter(m => m.direction === "inbound").length,
    products,
    allText,
  );

  if (!rawMessages.length) {
    return {
      actionType: "info_only",
      recommendation: "No hay mensajes para analizar.",
      nextAction: "Iniciar contacto",
      suggestedDate: null,
      closeProbability: "baja",
      risks: ["Sin mensajes en la conversación"],
      nextStep: "Escribir el primer mensaje al cliente.",
      task: { title: `Contactar a ${contactName}`, description: "Iniciar conversación.", dueAt: null, priority: "low", type: "follow_up", motif: "" },
      explanation: "No hay mensajes para analizar.",
      summary: "Sin mensajes.",
      intent,
      clientClassification: clientClass,
    };
  }

  // Already chronological (either passed in order or reversed above)
  const messages = rawMessages;
  const history = visibleMessages ? [] : messages.slice(0, -10);
  const recent = visibleMessages ? messages : messages.slice(-10);

  const fmtMsg = (m: typeof messages[0]) => {
    const role = m.direction === "inbound" ? "CLIENTE" : "VENDEDOR";
    const ts = m.sentAt ? fmtTime(m.sentAt) : "";
    return `[${ts}] ${role}: ${(m.content || "").substring(0, 400)}`;
  };

  const historyBlock = history.length ? `[HISTORIAL ANTERIOR]\n${history.map(fmtMsg).join("\n")}\n\n` : "";
  const focusLabel = visibleMessages ? "MENSAJES VISIBLES EN PANTALLA" : "ÚLTIMOS MENSAJES — MÁXIMO PESO";
  const recentBlock = `[${focusLabel}]\n${recent.map(fmtMsg).join("\n")}`;
  const today = fmtDate(new Date());

  const systemPrompt = `Sos un asistente comercial experto para una empresa de venta de equipamiento industrial en Argentina.
Analizá los mensajes de WhatsApp entre VENDEDOR y CLIENTE que te paso.

${visibleMessages ? "IMPORTANTE: Estos son los mensajes que el operador tiene en pantalla en este momento. Basá tu análisis ÚNICAMENTE en estos mensajes." : "IMPORTANTE: Los ÚLTIMOS MENSAJES (sección \"MÁXIMO PESO\") tienen 70-80% de peso sobre el historial.\nDeterminan: siguiente paso, cuándo actuar, posibilidades reales de cierre."}

Fecha y hora actual: ${today}

REGLAS para determinar "actionType":
1. "calendar_event" → si hay una fecha Y hora específica mencionada (ej: "hoy a la noche", "mañana a las 10", "el viernes a las 3pm", "esta tarde"). Debe haber TANTO fecha COMO indicación de hora.
2. "info_only" → si la conversación es puramente social/casual sin ninguna acción comercial u operativa (saludos, charla general sin fechas ni compromisos). Devolvé "recommendation" explicando brevemente.
3. "task" → todo lo demás que requiere seguimiento o acción pero sin fecha+hora específica.

Para "calendar_event", "suggestedDateTime" debe ser "YYYY-MM-DDTHH:mm" en hora local Argentina (UTC-3). Si la hora no es exacta, estimá lo más razonable (ej: "a la noche" → 20:00).

Tipos de tarea válidos (para "task" y "calendar_event"):
call_client, send_quote, send_catalog, send_invoice, send_docs, schedule_visit, wait_response, follow_up, other

Devolvé ÚNICAMENTE un JSON válido sin markdown ni explicación:
{
  "actionType": "task" | "calendar_event" | "info_only",
  "recommendation": "solo para info_only: descripción breve de qué dice la conversación",
  "nextAction": "acción concisa en infinitivo, máx 60 chars",
  "suggestedDate": "YYYY-MM-DD o null",
  "suggestedDateTime": "YYYY-MM-DDTHH:mm o null (solo para calendar_event)",
  "closeProbability": "alta" | "media" | "baja",
  "risks": ["riesgo concreto 1", "riesgo 2"],
  "nextStep": "descripción del siguiente paso en 1-2 oraciones",
  "task": {
    "title": "título de la tarea en infinitivo, máx 80 chars",
    "description": "qué hay que hacer exactamente, 2-3 oraciones",
    "dueAt": "YYYY-MM-DD o null",
    "priority": "high" | "medium" | "low",
    "type": "uno de los tipos válidos",
    "motif": "frase exacta o paráfrasis que originó esta tarea"
  },
  "explanation": "Esta tarea fue sugerida porque el cliente indicó: \\"...\\" por lo tanto se propone: \\"...\\"."
}`;

  const userPrompt = `Cliente: ${contactName}\n\n${historyBlock}${recentBlock}`;

  let parsed: any = null;
  try {
    const wsIdForAnalysis = conv?.workspaceId;
    // BYO AI gate — deep analysis requires a verified provider
    const { ready: deepReady, reason: deepReason } = isAIReady(wsIdForAnalysis);
    if (!deepReady) {
      logAIBlocked("analyzeConversationDeep", deepReason ?? "no reason", wsIdForAnalysis);
      return {
        nextAction: AI_DISCONNECTED_MESSAGE,
        suggestedDate: null,
        closeProbability: "media" as const,
        risks: ["IA desconectada — configurá un proveedor para el análisis profundo"],
        nextStep: AI_DISCONNECTED_MESSAGE,
        task: null,
        clientClassification: null,
        suggestedProducts: [],
        suggestedTopics: [],
      } as any;
    }
    const client = getClient(wsIdForAnalysis);
    const deepModel = getAIModel(wsIdForAnalysis);
    const response = await client.chat.completions.create({
      model: deepModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.25,
      max_tokens: 900,
      response_format: { type: "json_object" },
    });
    _logTokenUsage(deepModel, "analyzeConversationDeep", response.usage);
    parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
  } catch (e) {
    logger.error({ err: e }, "analyzeConversationDeep LLM call failed");
  }

  const closeProbability = (["alta", "media", "baja"] as const).includes(parsed?.closeProbability)
    ? parsed.closeProbability as "alta" | "media" | "baja"
    : "media";
  const priority = (["high", "medium", "low"] as const).includes(parsed?.task?.priority)
    ? parsed.task.priority as "high" | "medium" | "low"
    : "medium";
  const validTypes = ["call_client", "send_quote", "send_catalog", "send_invoice", "send_docs", "schedule_visit", "wait_response", "follow_up", "other"];
  const type = validTypes.includes(parsed?.task?.type) ? parsed.task.type : "follow_up";

  // Validate actionType
  const validActionTypes = ["task", "calendar_event", "info_only"] as const;
  const actionType: "task" | "calendar_event" | "info_only" = validActionTypes.includes(parsed?.actionType)
    ? parsed.actionType as "task" | "calendar_event" | "info_only"
    : "task";

  const summary = parsed?.nextAction || `Seguimiento con ${contactName}`;

  // Only update aiSummary for non-trivial analyses
  if (actionType !== "info_only") {
    await db.update(conversationsTable).set({ aiSummary: summary })
      .where(eq(conversationsTable.id, conversationId));
  }

  // For info_only, task can be null (no action needed)
  const taskResult = actionType === "info_only" ? null : {
    title: parsed?.task?.title || `Seguimiento con ${contactName}`,
    description: parsed?.task?.description || "",
    dueAt: parsed?.task?.dueAt || null,
    priority,
    type,
    motif: parsed?.task?.motif || "",
  };

  return {
    actionType,
    recommendation: actionType === "info_only" ? (parsed?.recommendation || parsed?.nextAction || "Sin acciones pendientes.") : undefined,
    nextAction: parsed?.nextAction || `Hacer seguimiento con ${contactName}`,
    suggestedDate: parsed?.suggestedDate || null,
    suggestedDateTime: parsed?.suggestedDateTime || null,
    closeProbability,
    risks: Array.isArray(parsed?.risks) ? parsed.risks.slice(0, 5) : [],
    nextStep: parsed?.nextStep || "",
    task: taskResult,
    explanation: parsed?.explanation || "",
    summary,
    intent,
    clientClassification: clientClass,
  };
}

// ─── Temporal commitment detection ───────────────────────────────────────────

export interface TemporalCommitment {
  detected: boolean;
  estimatedAt: Date | null;
  summary: string;
  /** true when a date was detected but the exact time could not be determined */
  timeUncertain?: boolean;
}

const DAYS_ES: Record<string, number> = {
  lunes: 1, martes: 2, miercoles: 3, jueves: 4,
  viernes: 5, sabado: 6, domingo: 0,
};

/**
 * Argentina is UTC-3 (no DST). When the server runs in UTC, `setHours` sets UTC
 * hours. To store "H:mm Argentina" correctly as UTC we add the 3-hour offset.
 * This makes Date objects comparable and round-trips correctly through
 * `toLocalDateTimeString(date, "America/Argentina/Buenos_Aires")` in calendarSync.
 */
const ARG_UTC_OFFSET_H = 3; // UTC-3 → add 3 h to convert Argentina → UTC
const DEFAULT_HOUR_ARG = 9; // default local hour when none mentioned (09:00 Argentina)

function nextWeekday(dayNum: number, from: Date): Date {
  const d = new Date(from);
  const cur = d.getUTCDay();
  let diff = dayNum - cur;
  if (diff <= 0) diff += 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(DEFAULT_HOUR_ARG + ARG_UTC_OFFSET_H, 0, 0, 0);
  return d;
}

/**
 * Pure, synchronous detection of temporal commitment expressions in text.
 * Returns the estimated date/time when the commitment is expected to happen.
 * Handles Spanish relative expressions (mañana, el lunes, a las 15, etc.).
 *
 * NEW patterns (Fase 2.1):
 *  "a las 5 de la tarde" → 17:00 · "a las 5 de la mañana" → 05:00
 *  "a las 5" (ambiguous 1-7h) → 17:00 (business context)
 *  "después del almuerzo" → 13:30 · "no antes de las 18" → 18:00
 *  "el fin de semana" → next Saturday 09:00
 *  "la semana que viene/próxima" → next Monday 09:00
 *  timeUncertain flag when date found but time was not specified
 */
export function detectTemporalCommitment(text: string, now: Date): TemporalCommitment {
  // Normalize: strip accents + lowercase
  const lower = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // ── Hour extraction ───────────────────────────────────────────────────────
  let mentionedHour: number | null = null;
  let mentionedMin  = 0;

  // "no antes de las N" — check first so "las 18" doesn't re-match below
  const noAntesMatch = lower.match(/\bno\s+antes\s+de\s+las?\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (noAntesMatch) {
    mentionedHour = parseInt(noAntesMatch[1]);
    mentionedMin  = parseInt(noAntesMatch[2] ?? "0");
    // Hours ≥ 8 are unambiguous; 1-7 would be unusual for "no antes de", keep as-is
  }

  // "después del almuerzo" → 13:30
  if (mentionedHour === null && /\bdespues\s+del?\s+almuerzo\b/.test(lower)) {
    mentionedHour = 13;
    mentionedMin  = 30;
  }

  // "a las N [de la tarde|noche|mañana]" — with optional period modifier
  if (mentionedHour === null) {
    const hMatch = lower.match(
      /\ba las?\s+(\d{1,2})(?::(\d{2}))?\s*(?:hs?\.?|horas?)?\s*(?:de\s+la\s+(tarde|noche|man[ao]na))?/,
    );
    if (hMatch) {
      let h   = parseInt(hMatch[1]);
      const m = parseInt(hMatch[2] ?? "0");
      const mod = hMatch[3]; // "tarde", "noche", "manana" / "maona"
      if (mod === "tarde" || mod === "noche") {
        if (h < 12) h += 12; // "5 de la tarde" → 17
      } else if (!mod && h >= 1 && h <= 7) {
        h += 12; // ambiguous 1-7 without modifier → PM (business context)
      }
      mentionedHour = h;
      mentionedMin  = m;
    }
  }

  const hasTime = mentionedHour !== null;
  const p2 = (n: number) => String(n).padStart(2, "0");

  /** Store Argentina local time H:m as UTC by adding the 3h offset */
  function setArgTime(d: Date, h: number, m: number): void {
    d.setUTCHours(h + ARG_UTC_OFFSET_H, m, 0, 0);
  }

  /** Apply the detected hour (or default) to a base date, pushing to next day if past */
  function applyHour(base: Date): Date {
    const d = new Date(base);
    const h = mentionedHour ?? DEFAULT_HOUR_ARG;
    const m = mentionedHour !== null ? mentionedMin : 0;
    setArgTime(d, h, m);
    // If the resulting UTC time is in the past today, push one day forward
    if (mentionedHour !== null && d <= now && base.toDateString() === now.toDateString()) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  }

  function timeSuffix(): string {
    return hasTime ? ` a las ${p2(mentionedHour!)}:${p2(mentionedMin)}` : "";
  }

  // ── pasado mañana ────────────────────────────────────────────────────────
  if (/\bpasado manana\b/.test(lower)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 2);
    setArgTime(d, DEFAULT_HOUR_ARG, 0);
    return {
      detected: true, estimatedAt: applyHour(d),
      summary: `pasado mañana${timeSuffix()}`,
      timeUncertain: !hasTime,
    };
  }

  // ── mañana ───────────────────────────────────────────────────────────────
  if (/\bmanana\b/.test(lower)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    setArgTime(d, DEFAULT_HOUR_ARG, 0);
    return {
      detected: true, estimatedAt: applyHour(d),
      summary: `mañana${timeSuffix()}`,
      timeUncertain: !hasTime,
    };
  }

  // ── day of week (el lunes, este martes, próximo viernes, plain "viernes") ─
  for (const [day, dayNum] of Object.entries(DAYS_ES)) {
    const re = new RegExp(`\\b(?:(?:el|este|proximo)\\s+)?${day}\\b`);
    if (re.test(lower)) {
      const d = nextWeekday(dayNum, now);
      return {
        detected: true, estimatedAt: applyHour(d),
        summary: `el ${day}${timeSuffix()}`,
        timeUncertain: !hasTime,
      };
    }
  }

  // ── en X días ─────────────────────────────────────────────────────────────
  const inDaysMatch = lower.match(/\ben\s+(\d+)\s+dias?\b/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1]);
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + days);
    setArgTime(d, DEFAULT_HOUR_ARG, 0);
    return {
      detected: true, estimatedAt: applyHour(d),
      summary: `en ${days} días${timeSuffix()}`,
      timeUncertain: !hasTime,
    };
  }

  // ── la semana que viene / próxima semana → next Monday ────────────────────
  if (/\b(?:la\s+)?semana\s+(?:que\s+viene|proxima|siguiente)\b/.test(lower)) {
    const d = nextWeekday(1, now); // Monday
    return {
      detected: true, estimatedAt: applyHour(d),
      summary: `la semana próxima${timeSuffix()}`,
      timeUncertain: !hasTime,
    };
  }

  // ── el fin de semana → next Saturday ──────────────────────────────────────
  if (/\bfin\s+de\s+semana\b/.test(lower)) {
    const d = nextWeekday(6, now); // Saturday
    return {
      detected: true, estimatedAt: applyHour(d),
      summary: `el fin de semana${timeSuffix()}`,
      timeUncertain: !hasTime,
    };
  }

  // ── fin de mes ────────────────────────────────────────────────────────────
  if (/\bfin\s+de\s+mes\b/.test(lower)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    setArgTime(d, DEFAULT_HOUR_ARG, 0);
    return {
      detected: true, estimatedAt: applyHour(d),
      summary: `fin de mes${timeSuffix()}`,
      timeUncertain: !hasTime,
    };
  }

  // ── commitment verb + hour mention ────────────────────────────────────────
  const COMMITMENT_VERBS = [
    "te llamo", "me llamas", "llamamos", "hablamos", "nos vemos",
    "nos reunimos", "te mando", "te escribo", "me paso", "vengo",
    "paso por", "confirmo", "lo envio", "te lo envio", "te lo mando",
    "te comento", "cotizacion", "cotizacion",
  ];
  if (mentionedHour !== null && COMMITMENT_VERBS.some(v => lower.includes(v))) {
    const d = new Date(now);
    setArgTime(d, mentionedHour, mentionedMin);
    if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
    return {
      detected: true, estimatedAt: d,
      summary: `a las ${p2(mentionedHour)}:${p2(mentionedMin)}`,
    };
  }

  // ── solo una mención de hora en mensaje corto ─────────────────────────────
  if (mentionedHour !== null && text.length < 120) {
    const d = new Date(now);
    setArgTime(d, mentionedHour, mentionedMin);
    if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
    return {
      detected: true, estimatedAt: d,
      summary: `a las ${p2(mentionedHour)}:${p2(mentionedMin)}`,
    };
  }

  return { detected: false, estimatedAt: null, summary: "" };
}

/** Called on every new incoming message — classifies intent and optionally creates tasks (local, no API) */
export async function processIncomingMessage(
  conversationId: number,
  messageText: string,
  contactName: string,
) {
  try {
    // NOTE: this rule-based priority/task classification runs regardless of
    // agentMode (manual/solidario/autonomo/noche). agentMode only controls
    // whether the AI drafts/sends automatic REPLIES — it must not also gate
    // whether inbound messages get tagged and turned into tasks, otherwise
    // operators in "manual" mode (the common case) never get urgent tags or
    // auto-created tasks at all, even though this is pure keyword matching,
    // not an AI-generated action.

    // Guard: never overwrite archived or manually-resolved statuses
    const [conv] = await db.select({ status: conversationsTable.status, clientId: conversationsTable.clientId, workspaceId: conversationsTable.workspaceId }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));
    if (!conv || conv.status === "archived" || conv.status === "resolved") return null;
    const workspaceId = conv.workspaceId;

    // ── Master IA switch ────────────────────────────────────────────────────
    // Load all AI control settings in one query (avoids multiple round-trips).
    const [aiCtrl] = await db
      .select({
        tagAutomation: aiSettingsTable.tagAutomation,
        iaEnabled: aiSettingsTable.iaEnabled,
        autoTaskEnabled: aiSettingsTable.autoTaskEnabled,
        autoPipelineEnabled: aiSettingsTable.autoPipelineEnabled,
        autoPipelineMinConfidence: aiSettingsTable.autoPipelineMinConfidence,
      })
      .from(aiSettingsTable)
      .where(eq(aiSettingsTable.workspaceId, workspaceId))
      .limit(1);

    // When iaEnabled is false, all AI automation is disabled for this workspace.
    // En espera / Sin respuesta timers are exempt (they're timer-based, not AI).
    const iaEnabled = aiCtrl?.iaEnabled ?? true;
    if (!iaEnabled) return null;

    const autoTaskEnabled = aiCtrl?.autoTaskEnabled ?? true;
    const autoPipelineEnabled = aiCtrl?.autoPipelineEnabled ?? true;
    const autoPipelineMinConfidence = (aiCtrl?.autoPipelineMinConfidence ?? "medium") as "medium" | "high";

    // Per-tag automation toggle (Sistema > Etiquetas automáticas). Defaults to
    // enabled for every tag when the setting row/field is missing, so this
    // never silently disables a tag (e.g. "urgente") for existing installs.
    const stored = (aiCtrl?.tagAutomation ?? {}) as Partial<TagAutomation>;
    const tagAutomation: TagAutomation = { ...DEFAULT_TAG_AUTOMATION, ...stored };

    const isUrgent = tagAutomation.urgent && matchKeywords(messageText, URGENCY_KEYWORDS);
    const rawIntent = detectIntent(messageText);
    // If a tag was manually disabled, fold its intent back to a neutral one so
    // it doesn't drive status/task creation, without touching the keyword lists.
    const intent =
      (rawIntent === "quote_request" && !tagAutomation.awaiting_quote) ||
      (rawIntent === "complaint" && !tagAutomation.complaint)
        ? "inquiry"
        : rawIntent;
    const urgency: "high" | "medium" | "low" = isUrgent ? "high" : matchKeywords(messageText, QUOTE_KEYWORDS) || matchKeywords(messageText, PURCHASE_KEYWORDS) ? "medium" : "low";

    // Map to a valid DB status — null means "don't change status, waiting/unanswered timers handle it"
    let conversationStatus: "urgent" | "awaiting_quote" | "complaint" | null = null;
    if (isUrgent) {
      conversationStatus = "urgent";
    } else if (intent === "quote_request" && tagAutomation.awaiting_quote) {
      conversationStatus = "awaiting_quote";
    } else if ((intent === "complaint" || intent === "support") && tagAutomation.complaint) {
      // "complaint" covers both actual complaints AND general info/support requests
      conversationStatus = "complaint";
    }
    // If no specific classification, don't touch status — auto-tag timers (waiting/unanswered) handle it

    const createTask = autoTaskEnabled && (isUrgent || intent === "quote_request" || intent === "purchase" || intent === "complaint" || intent === "support");
    const taskTasks = createTask ? suggestTasks(intent, detectProducts(messageText), isUrgent, contactName, messageText) : [];

    // Only write status if we detected a specific AI-managed classification
    if (conversationStatus) {
      await db
        .update(conversationsTable)
        .set({ status: conversationStatus, priority: urgency })
        .where(eq(conversationsTable.id, conversationId));
    } else {
      // Only update priority; leave status for the auto-tag timers
      await db
        .update(conversationsTable)
        .set({ priority: urgency })
        .where(eq(conversationsTable.id, conversationId));
    }

    // Dedupe guard: avoid spamming duplicate auto-tasks when a client sends
    // several follow-up messages in a row — skip if there's already an open
    // (pending/in_progress) auto-created task for this conversation.
    const hasOpenTask = taskTasks.length
      ? (await db.select({ id: tasksTable.id }).from(tasksTable).where(and(
          eq(tasksTable.conversationId, conversationId),
          inArray(tasksTable.status, ["pending", "in_progress"]),
        )).limit(1)).length > 0
      : false;

    if (taskTasks.length && !hasOpenTask) {
      // Bug fix: this insert used to omit clientId, so auto-created tasks were
      // only reachable via conversationId — they never showed up on the
      // Cliente detail page's Tareas tab (which filters by clientId). Any
      // conversation linked to a client must propagate that link here too.
      const [createdTask] = await db
        .insert(tasksTable)
        .values({
          workspaceId,
          title: taskTasks[0].title,
          type: taskTasks[0].type,
          priority: urgency,
          status: "pending",
          conversationId,
          clientId: conv.clientId ?? null,
          description: `Auto-creado para ${contactName}`,
        })
        .returning({ id: tasksTable.id, title: tasksTable.title })
        .catch((e) => { logger.warn({ err: e }, "Auto-task creation failed"); return []; });

      if (createdTask && conv.clientId) {
        const { logClientEvent } = await import("./clientEvents");
        await logClientEvent({
          workspaceId,
          clientId: conv.clientId,
          type: "task_created",
          detail: `Tarea creada automáticamente: ${createdTask.title}`,
          actor: "IA",
          relatedType: "task",
          relatedId: createdTask.id,
        });
      }
    }

    // First version of automatic opportunity detection: when an inbound
    // message contains commercial-intent keywords, open an opportunity for
    // the client if one isn't already open, so sales signals aren't lost
    // even when the operator doesn't manually create one.
    if (conv.clientId && autoPipelineEnabled) {
      await maybeCreateOpportunityFromMessage(conv.clientId, messageText, contactName, workspaceId, conversationId, "inbound", autoPipelineMinConfidence);

      // Cada mensaje aporta al perfil del cliente: productos consultados y
      // etiquetas de interacción se acumulan a través de todas sus
      // conversaciones, no solo la actual — así el cliente se vuelve una
      // fuente de información real con el tiempo.
      const products = detectProducts(messageText);
      await accumulateClientKnowledge(conv.clientId, {
        products,
        interactionTag: conversationStatus ?? undefined,
      });
    }

    // Temporal commitment detection — emit a socket event so the frontend can
    // offer to create a task / calendar event from the detected date.
    // Runs on every inbound message; ignores archived/resolved (already guarded above).
    try {
      const commitment = detectTemporalCommitment(messageText, new Date());
      if (commitment.detected) {
        socketEmit(workspaceId, "conversation:commitment_detected", {
          conversationId,
          clientId: conv.clientId ?? null,
          estimatedAt: commitment.estimatedAt?.toISOString() ?? null,
          summary: commitment.summary,
          messageSnippet: messageText.substring(0, 150),
          contactName,
          timeUncertain: commitment.timeUncertain ?? false,
        });
      }
    } catch (_) { /* non-critical */ }

    // Fase 3.1: Auto-summary — every 8 inbound messages, refresh the conversation summary
    try {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messagesTable)
        .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.direction, "inbound")));
      if (count > 0 && count % 8 === 0) {
        // Fire-and-forget: update aiSummary in background
        analyzeConversation(conversationId).then((result) => {
          if (result?.summary) {
            db.update(conversationsTable)
              .set({ aiSummary: result.summary })
              .where(eq(conversationsTable.id, conversationId))
              .catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (_) { /* non-critical */ }

    return { intent, urgency, createTask, conversationStatus };
  } catch (e) {
    logger.error({ err: e }, "processIncomingMessage failed");
    return null;
  }
}

export async function searchDocuments(query: string, limit = 5, workspaceId?: number) {
  try {
    // Only fetch indexed (text-extracted) docs — skip binary blobs
    const docs = await db.select().from(documentsTable)
      .where(and(
        eq(documentsTable.indexed, true),
        ...(workspaceId !== undefined ? [eq(documentsTable.workspaceId, workspaceId)] : []),
      ))
      .limit(100);
    const queryLower = query.toLowerCase();
    const results = docs
      .filter(
        d =>
          d.content &&
          isReadableText(d.content) &&
          (d.name.toLowerCase().includes(queryLower) ||
            d.content.toLowerCase().includes(queryLower) ||
            d.description?.toLowerCase().includes(queryLower)),
      )
      .slice(0, limit)
      .map(d => {
        const idx = d.content?.toLowerCase().indexOf(queryLower) ?? -1;
        const excerpt =
          idx >= 0
            ? d.content!.substring(Math.max(0, idx - 100), idx + 200)
            : d.description || d.name;
        return {
          documentId: d.id,
          documentName: d.name,
          excerpt,
          score: idx >= 0 ? 0.9 : 0.6,
        };
      })
      .sort((a, b) => b.score - a.score);
    return results;
  } catch (_) {
    return [];
  }
}
