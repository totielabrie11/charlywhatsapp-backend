/**
 * Commercial Intelligence Engine — CRUD routes
 *
 * GET  /commercial/keywords             — list workspace keywords
 * POST /commercial/keywords             — create keyword
 * POST /commercial/keywords/seed        — seed defaults (idempotent)
 * PATCH /commercial/keywords/:id        — update keyword
 * DELETE /commercial/keywords/:id       — delete keyword
 *
 * GET  /commercial/rules                — list priority + stage rules
 * POST /commercial/rules                — create rule
 * PATCH /commercial/rules/:id           — update rule
 * DELETE /commercial/rules/:id          — delete rule
 * POST /commercial/rules/reset-defaults — wipe custom rules (revert to defaults)
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { commercialKeywordsTable, commercialRulesTable, clientsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  seedDefaultKeywords,
  syncCommercialState,
  DEFAULT_PRIORITY_RULES,
  DEFAULT_STAGE_RULES,
  DEFAULT_SEED_KEYWORDS,
} from "../services/commercialEngine";

const router = Router();

// ─── Keywords ─────────────────────────────────────────────────────────────────

router.get("/commercial/keywords", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const rows = await db
    .select()
    .from(commercialKeywordsTable)
    .where(eq(commercialKeywordsTable.workspaceId, workspaceId))
    .orderBy(commercialKeywordsTable.category, commercialKeywordsTable.keyword);
  res.json(rows);
});

router.post("/commercial/keywords", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { keyword, weight, category } = req.body;
  if (!keyword?.trim()) { res.status(400).json({ error: "keyword requerido" }); return; }
  const [row] = await db
    .insert(commercialKeywordsTable)
    .values({
      workspaceId,
      keyword: keyword.trim(),
      weight:   typeof weight === "number" ? weight : 5,
      category: category?.trim() || "general",
    })
    .returning();
  res.status(201).json(row);
});

// Seed default keywords (no-op if already seeded)
router.post("/commercial/keywords/seed", async (req, res) => {
  const workspaceId = req.workspaceId!;
  await seedDefaultKeywords(workspaceId);
  const rows = await db
    .select()
    .from(commercialKeywordsTable)
    .where(eq(commercialKeywordsTable.workspaceId, workspaceId));
  res.json({ seeded: rows.length, rows });
});

router.patch("/commercial/keywords/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { keyword, weight, category } = req.body;
  const update: Record<string, any> = {};
  if (keyword !== undefined) update.keyword  = keyword.trim();
  if (weight  !== undefined) update.weight   = weight;
  if (category !== undefined) update.category = category.trim();
  if (!Object.keys(update).length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const [row] = await db
    .update(commercialKeywordsTable)
    .set(update)
    .where(and(eq(commercialKeywordsTable.id, id), eq(commercialKeywordsTable.workspaceId, workspaceId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/commercial/keywords/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db
    .delete(commercialKeywordsTable)
    .where(and(eq(commercialKeywordsTable.id, id), eq(commercialKeywordsTable.workspaceId, workspaceId)));
  res.status(204).end();
});

// ─── Rules (priority + stage thresholds) ─────────────────────────────────────

router.get("/commercial/rules", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const rows = await db
    .select()
    .from(commercialRulesTable)
    .where(eq(commercialRulesTable.workspaceId, workspaceId))
    .orderBy(commercialRulesTable.type, commercialRulesTable.minScore);

  // If no custom rules, return the built-in defaults so the UI can show them
  if (rows.length === 0) {
    res.json({
      custom: false,
      priority: DEFAULT_PRIORITY_RULES,
      stage: DEFAULT_STAGE_RULES,
    });
    return;
  }
  res.json({
    custom: true,
    priority: rows.filter((r) => r.type === "priority"),
    stage:    rows.filter((r) => r.type === "stage"),
  });
});

router.post("/commercial/rules", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { type, minScore, maxScore, value } = req.body;
  if (!["priority", "stage"].includes(type)) { res.status(400).json({ error: "type must be 'priority' or 'stage'" }); return; }
  if (!value?.trim()) { res.status(400).json({ error: "value requerido" }); return; }
  const [row] = await db
    .insert(commercialRulesTable)
    .values({
      workspaceId,
      type,
      minScore: minScore ?? 0,
      maxScore: maxScore ?? 100,
      value:    value.trim(),
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/commercial/rules/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { minScore, maxScore, value } = req.body;
  const update: Record<string, any> = {};
  if (minScore !== undefined) update.minScore = minScore;
  if (maxScore !== undefined) update.maxScore = maxScore;
  if (value    !== undefined) update.value    = value.trim();
  if (!Object.keys(update).length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const [row] = await db
    .update(commercialRulesTable)
    .set(update)
    .where(and(eq(commercialRulesTable.id, id), eq(commercialRulesTable.workspaceId, workspaceId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/commercial/rules/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db
    .delete(commercialRulesTable)
    .where(and(eq(commercialRulesTable.id, id), eq(commercialRulesTable.workspaceId, workspaceId)));
  res.status(204).end();
});

// Reset to defaults: delete all custom rules for this workspace
router.post("/commercial/rules/reset-defaults", async (req, res) => {
  const workspaceId = req.workspaceId!;
  await db
    .delete(commercialRulesTable)
    .where(eq(commercialRulesTable.workspaceId, workspaceId));
  res.json({ reset: true, priority: DEFAULT_PRIORITY_RULES, stage: DEFAULT_STAGE_RULES });
});

// ─── Mass sync — SSE streaming ───────────────────────────────────────────────
// Streams Server-Sent Events while running syncCommercialState on every client.
// The client can cancel by closing the connection; the server detects res.destroyed.
router.post("/commercial/sync-all", async (req, res) => {
  const workspaceId = req.workspaceId!;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  const startedAt = Date.now();
  let analyzed = 0;
  let updated  = 0;
  let errors   = 0;

  try {
    const clients = await db
      .select({ id: clientsTable.id, name: clientsTable.name })
      .from(clientsTable)
      .where(eq(clientsTable.workspaceId, workspaceId));

    const total = clients.length;

    if (total === 0) {
      send({ type: "complete", analyzed: 0, updated: 0, errors: 0, durationMs: 0 });
      res.end();
      return;
    }

    for (const client of clients) {
      if (cancelled || res.destroyed) break;

      send({ type: "progress", current: analyzed + 1, total, clientName: client.name });

      try {
        await syncCommercialState(workspaceId, client.id);
        updated++;
      } catch {
        errors++;
      }
      analyzed++;

      // Yield to the event loop so other requests aren't starved
      await new Promise<void>((r) => setImmediate(r));
    }

    const durationMs = Date.now() - startedAt;

    if (cancelled || res.destroyed) {
      send({ type: "cancelled", analyzed, updated, errors, durationMs });
    } else {
      send({ type: "complete", analyzed, updated, errors, durationMs });
    }
  } catch (e: any) {
    send({ type: "error", message: e?.message ?? "Error inesperado" });
  }

  res.end();
});

export default router;
