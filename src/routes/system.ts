/**
 * Fase 4.1/4.2: Sistema route — WA event log + token usage stats.
 * RC 1.0: POST /system/reset — clear all operational data.
 * Exposed under /api/system/* for the admin panel.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  tokenUsageTable,
  messagesTable,
  tasksTable,
  conversationsTable,
  clientsTable,
  clientEventsTable,
  opportunitiesTable,
  activityLogTable,
  documentsTable,
  marketingCampaignsTable,
  marketingTemplatesTable,
  marketingAssetsTable,
  marketingSegmentsTable,
} from "@workspace/db";
import { eq, sql, gte, and } from "drizzle-orm";
import { getEvents, disconnect as waDisconnect } from "../services/whatsapp";
import { logger } from "../lib/logger";

const router = Router();

/** Admin guard: require X-Admin-Key header matching ADMIN_API_KEY env var.
 * Fail-closed: if ADMIN_API_KEY is not set in env, the route returns 503
 * (not configured) rather than allowing open access. This prevents the
 * destructive /system/reset endpoint from being callable on unprotected installs.
 */
function requireAdmin(req: any, res: any, next: () => void) {
  const secret = process.env["ADMIN_API_KEY"];
  if (!secret) {
    res.status(503).json({ error: "Admin API not configured. Set ADMIN_API_KEY env var to enable admin routes." });
    return;
  }
  const provided = req.headers["x-admin-key"];
  if (provided === secret) { next(); return; }
  res.status(401).json({ error: "Admin key required. Pass X-Admin-Key header matching ADMIN_API_KEY." });
}

/**
 * GET /system/stats
 * Returns token usage aggregated by day (last 30 days) and total,
 * plus the in-memory WhatsApp event log.
 */
router.get("/system/stats", requireAdmin, async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Aggregate by endpoint — scoped to this workspace
    const byEndpoint = await db
      .select({
        endpoint: tokenUsageTable.endpoint,
        totalCalls: sql<number>`count(*)::int`,
        totalTokens: sql<number>`sum(total_tokens)::int`,
        promptTokens: sql<number>`sum(prompt_tokens)::int`,
        completionTokens: sql<number>`sum(completion_tokens)::int`,
      })
      .from(tokenUsageTable)
      .where(and(
        eq(tokenUsageTable.workspaceId, workspaceId),
        gte(tokenUsageTable.createdAt, since30),
      ))
      .groupBy(tokenUsageTable.endpoint)
      .orderBy(sql`sum(total_tokens) desc`);

    // Daily totals (last 14 days)
    const dailyTotals = await db
      .select({
        day: sql<string>`date_trunc('day', created_at)::date::text`,
        totalTokens: sql<number>`sum(total_tokens)::int`,
        totalCalls: sql<number>`count(*)::int`,
      })
      .from(tokenUsageTable)
      .where(and(
        eq(tokenUsageTable.workspaceId, workspaceId),
        gte(tokenUsageTable.createdAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
      ))
      .groupBy(sql`date_trunc('day', created_at)`)
      .orderBy(sql`date_trunc('day', created_at) desc`)
      .limit(14);

    // Grand total
    const [totals] = await db
      .select({
        totalCalls: sql<number>`count(*)::int`,
        totalTokens: sql<number>`sum(total_tokens)::int`,
      })
      .from(tokenUsageTable)
      .where(eq(tokenUsageTable.workspaceId, workspaceId));

    res.json({
      totals: {
        calls: totals?.totalCalls ?? 0,
        tokens: totals?.totalTokens ?? 0,
      },
      byEndpoint,
      dailyTotals: dailyTotals.reverse(), // chronological
      waEvents: getEvents(workspaceId),
    });
  } catch (e) {
    logger.error({ err: e }, "System stats failed");
    res.status(500).json({ error: "Error obteniendo estadísticas del sistema" });
  }
});

/**
 * POST /system/reset
 * Clears all operational data for the calling workspace (conversations, messages,
 * clients, tasks, pipeline, activity log, token usage, documents) while preserving
 * configuration (AI settings, roles, restriction policies, WhatsApp credentials).
 *
 * Body (optional): { resetWhatsApp?: boolean }
 *   When true, also disconnects and clears the WhatsApp session for this workspace only.
 */
router.post("/system/reset", requireAdmin, async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { resetWhatsApp = false } = (req.body ?? {}) as { resetWhatsApp?: boolean };
  try {
    // Wrap DB deletes in a transaction so partial failure leaves no inconsistent state.
    // Delete in FK-safe order: children before parents.
    // messagesTable has workspaceId so we can delete directly without a JOIN.
    await db.transaction(async (tx) => {
      await tx.delete(messagesTable).where(eq(messagesTable.workspaceId, workspaceId));
      await tx.delete(tasksTable).where(eq(tasksTable.workspaceId, workspaceId));
      await tx.delete(opportunitiesTable).where(eq(opportunitiesTable.workspaceId, workspaceId));
      await tx.delete(conversationsTable).where(eq(conversationsTable.workspaceId, workspaceId));
      await tx.delete(clientEventsTable).where(eq(clientEventsTable.workspaceId, workspaceId));
      // Marketing: campaigns first (cascades to campaign_events, campaign_recipients,
      // campaign_run_logs) — must run before clients because campaign_recipients.client_id
      // has no ON DELETE CASCADE and would violate the FK if clients were deleted first.
      await tx.delete(marketingCampaignsTable).where(eq(marketingCampaignsTable.workspaceId, workspaceId));
      await tx.delete(marketingTemplatesTable).where(eq(marketingTemplatesTable.workspaceId, workspaceId));
      await tx.delete(marketingAssetsTable).where(eq(marketingAssetsTable.workspaceId, workspaceId));
      await tx.delete(marketingSegmentsTable).where(eq(marketingSegmentsTable.workspaceId, workspaceId));
      // Clients after marketing (client_profiles cascade from clients automatically)
      await tx.delete(clientsTable).where(eq(clientsTable.workspaceId, workspaceId));
      await tx.delete(documentsTable).where(eq(documentsTable.workspaceId, workspaceId));
      await tx.delete(activityLogTable).where(eq(activityLogTable.workspaceId, workspaceId));
      await tx.delete(tokenUsageTable).where(eq(tokenUsageTable.workspaceId, workspaceId));
    });

    // Optionally disconnect and clear the WhatsApp session for this workspace only.
    // This runs OUTSIDE the DB transaction because it touches the filesystem and
    // the in-memory Baileys socket — a WA error should not roll back the DB reset.
    if (resetWhatsApp) {
      try {
        await waDisconnect(workspaceId);
        logger.info({ workspaceId }, "WhatsApp session cleared as part of reset.");
      } catch (waErr) {
        logger.warn({ err: waErr, workspaceId }, "WhatsApp disconnect during reset failed — DB reset still committed.");
      }
    }

    logger.info({ workspaceId, resetWhatsApp }, "System reset completed — workspace operational data cleared.");
    res.json({
      ok: true,
      message: resetWhatsApp
        ? "Base de datos y sesión de WhatsApp reseteadas. La aplicación arrancará como una instalación nueva."
        : "Base de datos reseteada. La aplicación arrancará como una instalación nueva.",
    });
  } catch (e) {
    logger.error({ err: e }, "System reset failed");
    res.status(500).json({ error: "Error al resetear la base de datos: " + (e as Error).message });
  }
});

export default router;
