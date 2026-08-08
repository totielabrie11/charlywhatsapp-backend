/**
 * agentValidation.ts — única fuente de verdad para validar agentes IA activos.
 *
 * Usada por:
 *   - POST /conversations/test/inbound  (Prueba IA)
 *   - GET  /conversations/test/agents-status
 *   - _handleAutoReply en whatsapp.ts  (respuesta automática real)
 *
 * NUNCA modificar la lógica de IA, Motor Comercial, tareas, Calendar ni
 * ningún otro flujo. Solo controla si existe un agente activo válido antes
 * de generar respuestas automáticas al cliente.
 */

import { db } from "@workspace/db";
import { aiRolesTable, aiSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface AgentInfo {
  id: number;
  name: string;
  provider: string;
}

export interface AgentsStatus {
  totalAgents: number;
  activeAgents: AgentInfo[];
  hasValidProvider: boolean;
}

/**
 * Returns full agent status for a workspace — without AI fallbacks.
 * Queries only truly-active roles (active = true); never falls back to
 * the default role the way getActiveRoles() in ai.ts does.
 */
export async function getAgentsStatus(workspaceId: number): Promise<AgentsStatus> {
  const [allRoles, settings] = await Promise.all([
    db
      .select({ id: aiRolesTable.id, name: aiRolesTable.name, active: aiRolesTable.active })
      .from(aiRolesTable)
      .where(eq(aiRolesTable.workspaceId, workspaceId)),
    db
      .select({ primaryModel: aiSettingsTable.primaryModel })
      .from(aiSettingsTable)
      .where(eq(aiSettingsTable.workspaceId, workspaceId))
      .limit(1)
      .then(r => r[0] ?? null),
  ]);

  const provider = settings?.primaryModel ?? "groq";
  // The AI service uses Groq; treat the key as valid when it is not the placeholder default.
  const hasValidProvider = (process.env.GROQ_API_KEY ?? "placeholder") !== "placeholder";

  const activeAgents = allRoles
    .filter(r => r.active)
    .map(r => ({ id: r.id, name: r.name, provider }));

  return { totalAgents: allRoles.length, activeAgents, hasValidProvider };
}

/**
 * Quick boolean check: returns true only when there is at least one active
 * agent AND the provider API key is configured. Call this before any
 * automatic client-facing LLM call.
 */
export async function hasActiveAgents(workspaceId: number): Promise<boolean> {
  const { activeAgents, hasValidProvider } = await getAgentsStatus(workspaceId);
  return activeAgents.length > 0 && hasValidProvider;
}
