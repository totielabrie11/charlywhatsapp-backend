import { Router } from "express";
import { db } from "@workspace/db";
import { opportunitiesTable, clientsTable, activityLogTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { logClientEvent } from "../services/clientEvents";

const router = Router();

// ─── List ─────────────────────────────────────────────────────────────────────
router.get("/pipeline", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { outcome } = req.query as { outcome?: string };

  const conditions = [eq(opportunitiesTable.workspaceId, workspaceId)];
  if (outcome === "open") conditions.push(eq(opportunitiesTable.outcome, "open"));
  else if (outcome === "closed") conditions.push(sql`${opportunitiesTable.outcome} IN ('won','lost')`);

  const opps = await db.select({
    opp: opportunitiesTable,
    clientName: clientsTable.name,
  })
    .from(opportunitiesTable)
    .leftJoin(clientsTable, eq(opportunitiesTable.clientId, clientsTable.id))
    .where(and(...conditions))
    .orderBy(desc(opportunitiesTable.createdAt));

  res.json(opps.map(({ opp, clientName }) => ({
    ...opp,
    clientName: clientName ?? null,
    createdAt: opp.createdAt.toISOString(),
    expectedCloseAt: opp.expectedCloseAt?.toISOString() ?? null,
    closedAt: opp.closedAt?.toISOString() ?? null,
  })));
});

// ─── Create ───────────────────────────────────────────────────────────────────
router.post("/pipeline", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const body = req.body;

  if (body.clientId) {
    const [clientCheck] = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(and(eq(clientsTable.id, parseInt(String(body.clientId))), eq(clientsTable.workspaceId, workspaceId)));
    if (!clientCheck) { res.status(404).json({ error: "Client not found" }); return; }
  }

  const [opp] = await db.insert(opportunitiesTable).values({
    workspaceId,
    title: body.title,
    clientId: body.clientId || null,
    stage: body.stage || "prospect",
    value: body.value || 0,
    probability: body.probability || 50,
    product: body.product || null,
    description: body.description || null,
    source: body.source || "manual",
    expectedCloseAt: body.expectedCloseAt ? new Date(body.expectedCloseAt) : null,
    outcome: "open",
  }).returning();

  // Fetch client name + company for the opportunity
  let oppCreatedClient: { name: string | null; company: string | null } | null = null;
  if (opp.clientId) {
    const [cl] = await db.select({ name: clientsTable.name, company: clientsTable.company })
      .from(clientsTable).where(eq(clientsTable.id, opp.clientId)).catch(() => []);
    oppCreatedClient = cl ?? null;
  }
  await db.insert(activityLogTable).values({
    workspaceId, type: "opportunity_created",
    description: `Oportunidad creada: ${opp.title}${opp.value ? ` · $${opp.value.toLocaleString("es-AR")}` : ""}`,
    clientName: oppCreatedClient?.name ?? null,
    companyName: oppCreatedClient?.company ?? null,
  });
  await logClientEvent({
    workspaceId, clientId: opp.clientId, type: "opportunity_created",
    detail: `Oportunidad creada: ${opp.title}${opp.value ? ` · $${opp.value.toLocaleString("es-AR")}` : ""}`,
    actor: "Operador", relatedType: "opportunity", relatedId: opp.id,
  });

  res.status(201).json({
    ...opp,
    clientName: null,
    createdAt: opp.createdAt.toISOString(),
    expectedCloseAt: opp.expectedCloseAt?.toISOString() ?? null,
    closedAt: null,
  });
});

// ─── Update (stage + content fields) ──────────────────────────────────────────
router.patch("/pipeline/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify it exists and belongs to this workspace
  const [existing] = await db.select().from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  // Closed opportunities cannot be re-opened via PATCH — use /reopen
  if (existing.outcome !== "open" && req.body.stage) {
    res.status(409).json({ error: "Opportunity is closed. Use /reopen to re-open it." });
    return;
  }

  const body = req.body;
  const update: Record<string, unknown> = {};
  const allowed = ["title", "stage", "value", "probability", "product", "description", "source"];
  for (const key of allowed) {
    if (body[key] !== undefined) update[key] = body[key];
  }
  if (body.expectedCloseAt !== undefined) {
    update.expectedCloseAt = body.expectedCloseAt ? new Date(body.expectedCloseAt) : null;
  }

  const [opp] = await db.update(opportunitiesTable).set(update)
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)))
    .returning();

  if (body.stage) {
    // Fetch client info for stage change event
    let oppMovedClient: { name: string | null; company: string | null } | null = null;
    if (opp.clientId) {
      const [cl] = await db.select({ name: clientsTable.name, company: clientsTable.company })
        .from(clientsTable).where(eq(clientsTable.id, opp.clientId)).catch(() => []);
      oppMovedClient = cl ?? null;
    }
    const stageLabels: Record<string, string> = {
      prospect: "Prospecto", quote_sent: "Cotización enviada", negotiation: "Negociación",
      sale: "Venta cerrada", delivery: "Entrega", after_sale: "Post-venta", lost: "Perdida",
    };
    await db.insert(activityLogTable).values({
      workspaceId, type: "opportunity_moved",
      description: `"${opp.title}" avanzó a ${stageLabels[body.stage] ?? body.stage}`,
      clientName: oppMovedClient?.name ?? null,
      companyName: oppMovedClient?.company ?? null,
    });
    await logClientEvent({
      workspaceId, clientId: opp.clientId, type: "stage_changed",
      detail: `Oportunidad "${opp.title}" avanzó a etapa: ${body.stage}`,
      actor: "Operador", relatedType: "opportunity", relatedId: opp.id,
    });
  } else if (Object.keys(update).length > 0) {
    await logClientEvent({
      workspaceId, clientId: opp.clientId, type: "opportunity_updated",
      detail: `Oportunidad "${opp.title}" actualizada`,
      actor: "Operador", relatedType: "opportunity", relatedId: opp.id,
    });
  }

  const [row] = await db.select({ clientName: clientsTable.name })
    .from(opportunitiesTable)
    .leftJoin(clientsTable, eq(opportunitiesTable.clientId, clientsTable.id))
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)));

  res.json({
    ...opp,
    clientName: row?.clientName ?? null,
    createdAt: opp.createdAt.toISOString(),
    expectedCloseAt: opp.expectedCloseAt?.toISOString() ?? null,
    closedAt: opp.closedAt?.toISOString() ?? null,
  });
});

// ─── Close (won / lost) ───────────────────────────────────────────────────────
// This is the permanent record: once closed the opportunity lives forever on the client.
router.post("/pipeline/:id/close", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { outcome, notes } = req.body as { outcome: "won" | "lost"; notes?: string };
  if (outcome !== "won" && outcome !== "lost") {
    res.status(400).json({ error: "outcome must be 'won' or 'lost'" });
    return;
  }

  const [opp] = await db.update(opportunitiesTable).set({
    outcome,
    stage: outcome === "won" ? "sale" : "lost",
    closedAt: new Date(),
    outcomeNotes: notes ?? null,
    probability: outcome === "won" ? 100 : 0,
  })
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)))
    .returning();

  if (!opp) { res.status(404).json({ error: "Not found" }); return; }

  // Keep clients.total_sales in sync: increment on win, leave unchanged on loss.
  if (outcome === "won" && opp.clientId) {
    await db.update(clientsTable)
      .set({ totalSales: sql`total_sales + ${opp.value}` })
      .where(and(eq(clientsTable.id, opp.clientId), eq(clientsTable.workspaceId, workspaceId)));
  }

  const label = outcome === "won" ? "Ganada" : "Perdida";
  const eventType = outcome === "won" ? "opportunity_won" : "opportunity_lost";

  // Fetch client info for close event — do before the response join
  let oppCloseClient: { name: string | null; company: string | null } | null = null;
  if (opp.clientId) {
    const [cl] = await db.select({ name: clientsTable.name, company: clientsTable.company })
      .from(clientsTable).where(eq(clientsTable.id, opp.clientId)).catch(() => []);
    oppCloseClient = cl ?? null;
  }
  await db.insert(activityLogTable).values({
    workspaceId, type: eventType,
    description: `Oportunidad ${label}: ${opp.title}${opp.value ? ` · $${opp.value.toLocaleString("es-AR")}` : ""}`,
    clientName: oppCloseClient?.name ?? null,
    companyName: oppCloseClient?.company ?? null,
  });
  await logClientEvent({
    workspaceId, clientId: opp.clientId, type: eventType,
    detail: `Oportunidad ${label}: "${opp.title}"${opp.value ? ` · $${opp.value.toLocaleString("es-AR")}` : ""}${notes ? ` — ${notes}` : ""}`,
    actor: "Operador", relatedType: "opportunity", relatedId: opp.id,
  });

  const [row] = await db.select({ clientName: clientsTable.name })
    .from(opportunitiesTable)
    .leftJoin(clientsTable, eq(opportunitiesTable.clientId, clientsTable.id))
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)));

  res.json({
    ...opp,
    clientName: row?.clientName ?? null,
    createdAt: opp.createdAt.toISOString(),
    expectedCloseAt: opp.expectedCloseAt?.toISOString() ?? null,
    closedAt: opp.closedAt!.toISOString(),
  });
});

// ─── Reopen ───────────────────────────────────────────────────────────────────
router.post("/pipeline/:id/reopen", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Fetch before updating so we know the previous outcome/value.
  const [before] = await db.select({
    outcome: opportunitiesTable.outcome,
    value: opportunitiesTable.value,
    clientId: opportunitiesTable.clientId,
  }).from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)));

  const [opp] = await db.update(opportunitiesTable).set({
    outcome: "open",
    stage: "negotiation",
    closedAt: null,
    outcomeNotes: null,
    probability: 50,
  })
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)))
    .returning();

  if (!opp) { res.status(404).json({ error: "Not found" }); return; }

  // Undo the totalSales increment applied when the deal was won.
  if (before?.outcome === "won" && before.clientId) {
    await db.update(clientsTable)
      .set({ totalSales: sql`GREATEST(0, total_sales - ${before.value})` })
      .where(and(eq(clientsTable.id, before.clientId), eq(clientsTable.workspaceId, workspaceId)));
  }

  await logClientEvent({
    workspaceId, clientId: opp.clientId, type: "opportunity_reopened",
    detail: `Oportunidad "${opp.title}" reabierta`,
    actor: "Operador", relatedType: "opportunity", relatedId: opp.id,
  });

  res.json({
    ...opp,
    clientName: null,
    createdAt: opp.createdAt.toISOString(),
    expectedCloseAt: opp.expectedCloseAt?.toISOString() ?? null,
    closedAt: null,
  });
});

// ─── Delete (only open opportunities can be deleted) ──────────────────────────
router.delete("/pipeline/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select({ id: opportunitiesTable.id, outcome: opportunitiesTable.outcome, title: opportunitiesTable.title, clientId: opportunitiesTable.clientId })
    .from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)));

  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.outcome !== "open") {
    res.status(409).json({ error: "Closed opportunities cannot be deleted. They are permanent records." });
    return;
  }

  await db.delete(opportunitiesTable).where(and(eq(opportunitiesTable.id, id), eq(opportunitiesTable.workspaceId, workspaceId)));
  await logClientEvent({
    workspaceId, clientId: existing.clientId, type: "opportunity_deleted",
    detail: `Oportunidad eliminada: "${existing.title}"`,
    actor: "Operador", relatedType: "opportunity", relatedId: id,
  });
  res.status(204).end();
});

export default router;
