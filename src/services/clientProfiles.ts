/**
 * Client Profile Computation Engine — Fase 2
 *
 * Rule-based (no AI) engine that analyzes a client's conversation history to:
 * 1. Detect commercial interests via keyword matching
 * 2. Classify activity level
 * 3. Compute a commercial score
 * 4. Upsert the result into client_profiles
 *
 * This service never modifies clients, conversations, or messages.
 */

import { db } from "@workspace/db";
import {
  clientsTable,
  clientProfilesTable,
  conversationsTable,
  messagesTable,
  tasksTable,
  opportunitiesTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";

// ─── Interest keyword map ─────────────────────────────────────────────────────
// Each entry maps a business interest label to detecting keywords.
// Keywords are matched case-insensitively as substrings.
const INTEREST_MAP: Array<{ interest: string; keywords: string[] }> = [
  {
    interest: "Motores Eléctricos",
    keywords: [
      "motor", "motores", "ie1", "ie2", "ie3", "weg", "abb",
      "siemens", "innomotics", "kw", "rpm", "trifasico", "trifásico",
      "monofasico", "monofásico", "simotics", "1la", "1le",
      "asíncrono", "asincrono", "induccion", "inducción",
    ],
  },
  {
    interest: "Variadores de Frecuencia",
    keywords: [
      "variador", "vfd", "inverter", "g120", "g115",
      "micromaster", "sinamics", "frecuencia", "arrancador",
      "soft starter", "drive",
    ],
  },
  {
    interest: "Bombas y Fluidos",
    keywords: [
      "bomba", "bombas", "centrífuga", "centrifuga", "periférica",
      "periferica", "caudal", "presión", "fluido", "impeller", "vacío", "vacio",
    ],
  },
  {
    interest: "Automatización / PLC",
    keywords: [
      "plc", "s7", "simatic", "logo", "hmi", "scada",
      "automatización", "automatizacion", "programación", "programacion",
      "tablero", "arranque", "control",
    ],
  },
  {
    interest: "Contactores y Protecciones",
    keywords: [
      "contactor", "relé", "rele", "sirius", "3rt",
      "térmico", "termico", "overload", "protección", "bimetálico",
    ],
  },
  {
    interest: "Interruptores y Tableros",
    keywords: [
      "interruptor", "disyuntor", "breaker", "sentron",
      "3va", "3vl", "diferencial", "tablero eléctrico", "switchgear",
    ],
  },
  {
    interest: "Transformadores / UPS",
    keywords: [
      "transformador", "trafo", "ups", "rectificador",
      "tensión", "voltaje", "220v", "380v", "440v",
    ],
  },
  {
    interest: "Cables y Conexiones",
    keywords: [
      "cable", "conductor", "bornera", "bornes",
      "terminal", "conector", "triflex",
    ],
  },
  {
    interest: "Componentes ATEX",
    keywords: [
      "atex", "explosión", "explosion", "ip55", "ip66",
      "intrínsecamente", "intrinsecamente", "zona 1", "zona 2", "antideflagrante",
    ],
  },
  {
    interest: "Cotización / Precios",
    keywords: [
      "precio", "cotización", "cotizacion", "presupuesto",
      "cuánto", "cuanto", "costo", "oferta", "stock", "catálogo", "catalogo",
    ],
  },
  {
    interest: "Repuestos",
    keywords: [
      "repuesto", "repuestos", "recambio", "spare",
      "recambios", "pieza", "piezas",
    ],
  },
];

// ─── Action keyword map ───────────────────────────────────────────────────────
const ACTION_KEYWORDS: Array<{ action: string; keywords: string[] }> = [
  { action: "purchase", keywords: ["compra", "pedido", "factura", "transferencia", "lo tomo", "lo compro", "compramos"] },
  { action: "quote", keywords: ["cotización", "cotizacion", "presupuesto", "precio", "cuánto", "cuanto", "costo"] },
  { action: "complaint", keywords: ["reclamo", "falla", "error", "no funciona", "roto", "defecto", "queja"] },
  { action: "technical", keywords: ["manual", "técnico", "configuración", "parámetro", "instalación", "conexion", "calibración"] },
  { action: "negotiation", keywords: ["descuento", "rebaja", "más barato", "competencia", "oferta"] },
  { action: "follow_up", keywords: ["esperando", "cuando", "novedades", "hay respuesta", "alguna novedad"] },
  { action: "inquiry", keywords: ["consulta", "información", "disponibilidad", "catálogo", "tenés"] },
];

// ─── Core computation ─────────────────────────────────────────────────────────

function detectInterests(text: string): string[] {
  const lower = text.toLowerCase();
  return INTEREST_MAP
    .filter(({ keywords }) => keywords.some((k) => lower.includes(k)))
    .map(({ interest }) => interest);
}

function detectLastAction(text: string): string | null {
  const lower = text.toLowerCase();
  for (const { action, keywords } of ACTION_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return action;
  }
  return null;
}

function classifyActivity(lastConvAt: Date | null, totalConvs: number): string {
  if (!lastConvAt || totalConvs === 0) return "lost";
  const daysSince = (Date.now() - lastConvAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 7) return "very_active";
  if (daysSince < 30) return "active";
  if (daysSince < 90) return "inactive";
  return "lost";
}

function computeScore(params: {
  totalConvs: number;
  recentConvs: number;
  openTasks: number;
  openOpps: number;
  purchasedProducts: string[];
  consultedProducts: string[];
  activityIndex: string;
}): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  let score = 10;
  breakdown.base = 10;

  if (params.totalConvs > 0) { breakdown.has_conversations = 10; score += 10; }
  const recentBonus = Math.min(20, params.recentConvs * 5);
  if (recentBonus > 0) { breakdown.recent_conversations = recentBonus; score += recentBonus; }
  if (params.openOpps > 0) { breakdown.open_opportunities = 20; score += 20; }
  if (params.openTasks > 0) { breakdown.open_tasks = 10; score += 10; }
  if (params.purchasedProducts.length > 0) { breakdown.purchase_history = 20; score += 20; }
  if (params.consultedProducts.length > 0) { breakdown.consulted_products = 10; score += 10; }
  if (params.activityIndex === "very_active") { breakdown.activity_bonus = 10; score += 10; }
  else if (params.activityIndex === "active") { breakdown.activity_bonus = 5; score += 5; }

  return { score: Math.min(100, score), breakdown };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function computeClientProfile(workspaceId: number, clientId: number): Promise<void> {
  // Fetch client
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.workspaceId, workspaceId)));
  if (!client) return;

  // Fetch conversations
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.clientId, clientId), eq(conversationsTable.workspaceId, workspaceId)))
    .orderBy(desc(conversationsTable.lastMessageAt));

  // Fetch all messages for these conversations
  const convIds = conversations.map((c) => c.id);
  let allMessageText = "";
  let lastMessageAt: Date | null = null;

  if (convIds.length > 0) {
    const messages = await db
      .select({ content: messagesTable.content, sentAt: messagesTable.sentAt })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convIds[0]!)); // sample first conv for perf

    // For interests, scan all messages but cap at 2000 chars per conv
    allMessageText = conversations
      .slice(0, 10)
      .map((c) => [c.lastMessage, c.aiSummary].filter(Boolean).join(" "))
      .join(" ");

    // Append actual message content from first conversation
    allMessageText += " " + messages.map((m) => m.content ?? "").join(" ");

    // Last conversation date
    const latestConv = conversations[0];
    if (latestConv?.lastMessageAt) lastMessageAt = latestConv.lastMessageAt;
  }

  // Fetch tasks and opportunities
  const openTasksResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(and(
      eq(tasksTable.clientId, clientId),
      eq(tasksTable.workspaceId, workspaceId),
      sql`status != 'completada'`,
    ));
  const openTasksCount = openTasksResult[0]?.count ?? 0;

  const openOppsResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.clientId, clientId), eq(opportunitiesTable.workspaceId, workspaceId)));
  const openOppsCount = openOppsResult[0]?.count ?? 0;

  // Recent conversations (within 30 days)
  const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentConvs = conversations.filter(
    (c) => c.lastMessageAt && c.lastMessageAt >= recentCutoff,
  ).length;

  // Compute contact frequency
  let contactFrequencyDays: number | null = null;
  if (conversations.length >= 2) {
    const dates = conversations
      .map((c) => c.lastMessageAt?.getTime())
      .filter((t): t is number => t !== null && t !== undefined)
      .sort((a, b) => b - a);
    if (dates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 0; i < dates.length - 1; i++) {
        gaps.push((dates[i]! - dates[i + 1]!) / (1000 * 60 * 60 * 24));
      }
      contactFrequencyDays = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    }
  }

  // Detect interests & activity
  const detectedInterests = detectInterests(allMessageText);
  const activityIndex = classifyActivity(lastMessageAt, conversations.length);
  const lastCommercialAction = detectLastAction(allMessageText);

  const { score, breakdown } = computeScore({
    totalConvs: conversations.length,
    recentConvs,
    openTasks: openTasksCount,
    openOpps: openOppsCount,
    purchasedProducts: client.purchasedProducts ?? [],
    consultedProducts: client.consultedProducts ?? [],
    activityIndex,
  });

  // Upsert profile
  await db
    .insert(clientProfilesTable)
    .values({
      workspaceId,
      clientId,
      activityIndex,
      contactFrequencyDays,
      detectedInterests,
      lastCommercialAction,
      commercialScore: score,
      scoreBreakdown: breakdown,
      totalConversations: conversations.length,
      openTasks: openTasksCount,
      openOpportunities: openOppsCount,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: clientProfilesTable.clientId,
      set: {
        activityIndex,
        contactFrequencyDays,
        detectedInterests,
        lastCommercialAction,
        commercialScore: score,
        scoreBreakdown: breakdown,
        totalConversations: conversations.length,
        openTasks: openTasksCount,
        openOpportunities: openOppsCount,
        computedAt: new Date(),
      },
    });
}

export async function computeAllProfiles(workspaceId: number): Promise<number> {
  const clients = await db
    .select({ id: clientsTable.id })
    .from(clientsTable)
    .where(eq(clientsTable.workspaceId, workspaceId));

  for (const client of clients) {
    await computeClientProfile(workspaceId, client.id);
  }
  return clients.length;
}
