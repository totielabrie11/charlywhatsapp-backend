import { Router } from "express";
import { db } from "@workspace/db";
import { clientsTable, conversationsTable, tasksTable, opportunitiesTable, activityLogTable, clientEventsTable, messagesTable } from "@workspace/db";
import { eq, ilike, or, desc, inArray, sql, and } from "drizzle-orm";
import { emit as socketEmit } from "../lib/socket";
import { logClientEvent } from "../services/clientEvents";
import { normalizePhone } from "../lib/phone";

const router = Router();

// List clients
router.get("/clients", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { search, priority } = req.query as { search?: string; priority?: string };

  let clients;
  if (search && priority && priority !== "all") {
    clients = await db.select().from(clientsTable)
      .where(and(
        eq(clientsTable.workspaceId, workspaceId),
        or(
          ilike(clientsTable.name, `%${search}%`),
          ilike(clientsTable.company ?? clientsTable.name, `%${search}%`),
          ilike(clientsTable.phone, `%${search}%`),
        ),
      ))
      .orderBy(desc(clientsTable.createdAt));
    clients = clients.filter(c => c.priority === priority);
  } else if (search) {
    clients = await db.select().from(clientsTable)
      .where(and(
        eq(clientsTable.workspaceId, workspaceId),
        or(
          ilike(clientsTable.name, `%${search}%`),
          ilike(clientsTable.phone, `%${search}%`),
        ),
      ))
      .orderBy(desc(clientsTable.createdAt));
  } else if (priority && priority !== "all") {
    clients = await db.select().from(clientsTable)
      .where(and(
        eq(clientsTable.workspaceId, workspaceId),
        eq(clientsTable.priority, priority),
      ))
      .orderBy(desc(clientsTable.createdAt));
  } else {
    clients = await db.select().from(clientsTable)
      .where(eq(clientsTable.workspaceId, workspaceId))
      .orderBy(desc(clientsTable.createdAt));
  }

  // One extra query to get won-opportunity totals for all clients in the
  // result set — avoids N+1 and keeps the list fast regardless of size.
  const clientIds = clients.map(c => c.id);
  const wonTotals = clientIds.length
    ? await db.select({
        clientId: opportunitiesTable.clientId,
        total: sql<number>`COALESCE(SUM(${opportunitiesTable.value}), 0)::float`,
      }).from(opportunitiesTable)
        .where(and(
          eq(opportunitiesTable.workspaceId, workspaceId),
          eq(opportunitiesTable.outcome, "won"),
          inArray(opportunitiesTable.clientId, clientIds),
        ))
        .groupBy(opportunitiesTable.clientId)
    : [];
  const wonMap = new Map(wonTotals.map(r => [r.clientId, r.total]));

  res.json(clients.map(c => ({
    ...c,
    totalSales: wonMap.get(c.id) ?? 0,   // computed from source-of-truth
    createdAt: c.createdAt.toISOString(),
    lastContactAt: c.lastContactAt?.toISOString() ?? null,
  })));
});

// Create client
router.post("/clients", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const body = req.body;
  const normalizedPhone = body.phone ? normalizePhone(body.phone) : body.phone;

  // Same person, same phone must always be the same Client row — otherwise
  // this creates a duplicate that silently splits conversations/tasks/
  // opportunities/history between two ids (the exact bug this guard fixes).
  if (normalizedPhone) {
    const [existing] = await db.select({ id: clientsTable.id })
      .from(clientsTable)
      .where(and(
        eq(clientsTable.workspaceId, workspaceId),
        eq(clientsTable.phone, normalizedPhone),
      ))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "Ya existe un cliente con ese teléfono.", clientId: existing.id });
      return;
    }
  }

  const [client] = await db.insert(clientsTable).values({
    workspaceId,
    name: body.name,
    company: body.company,
    phone: normalizedPhone,
    email: body.email,
    province: body.province,
    position: body.position,
    industry: body.industry,
    priority: body.priority || "B",
    stage: body.stage || "prospect",
    notes: body.notes,
  }).returning();

  await db.insert(activityLogTable).values({
    workspaceId,
    type: "client_created",
    description: `Nuevo cliente creado: ${client.name}`,
    clientName: client.name,
    companyName: client.company || null,
  });
  await logClientEvent({
    workspaceId,
    clientId: client.id,
    type: "client_created",
    detail: `Cliente creado: ${client.name}`,
    actor: "Sistema",
  });

  // Notify frontend so the CRM auto-sync picks up the new client and links
  // any existing conversation that matches this phone.
  socketEmit(workspaceId, "client:updated", { id: client.id });

  res.status(201).json({
    ...client,
    createdAt: client.createdAt.toISOString(),
    lastContactAt: client.lastContactAt?.toISOString() ?? null,
  });

  // Fire-and-forget: attempt to fetch WA profile photo for the new client.
  // Runs after the response is sent — never blocks the create flow.
  if (client.phone) {
    void import("../services/customerSync").then(({ fetchPhotoForClientAsync }) =>
      fetchPhotoForClientAsync(workspaceId, client.id, client.name, client.phone!)
    );
  }
});

// ─── POST /clients/:id/refresh-photo — on-demand synchronous photo fetch ───────
// Called when the user clicks the avatar in client-detail.
// Waits up to 8 s for WhatsApp to respond, then returns the result.
router.post("/clients/:id/refresh-photo", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { refreshPhotoForClient } = await import("../services/customerSync");
  const result = await refreshPhotoForClient(workspaceId, id);

  if (result.status === "updated") {
    socketEmit(workspaceId, "client:updated", { id });
    res.json({ status: "updated", profilePicUrl: result.profilePicUrl });
    return;
  }
  // no_photo / timeout / error / unchanged — all non-critical
  res.json({ status: result.status });
});

// ─── GET /clients/crm-sync-status — must be BEFORE /clients/:id ──────────────
// (Express matches routes in order; "crm-sync-status" would otherwise be
//  captured as :id by the handler below, returning 400 "Invalid id".)
router.get("/clients/crm-sync-status", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { getStatus } = await import("../services/customerSync");
  res.json(getStatus(workspaceId));
});

// Get client detail
router.get("/clients/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [client] = await db.select().from(clientsTable)
    .where(and(eq(clientsTable.id, id), eq(clientsTable.workspaceId, workspaceId)));
  if (!client) { res.status(404).json({ error: "Not found" }); return; }

  const conversations = await db.select().from(conversationsTable)
    .where(and(
      eq(conversationsTable.workspaceId, workspaceId),
      eq(conversationsTable.clientId, id),
    ))
    .orderBy(desc(conversationsTable.lastMessageAt));

  const tasks = await db.select().from(tasksTable)
    .where(and(
      eq(tasksTable.workspaceId, workspaceId),
      eq(tasksTable.clientId, id),
    ))
    .orderBy(desc(tasksTable.createdAt));

  const opportunities = await db.select().from(opportunitiesTable)
    .where(and(
      eq(opportunitiesTable.workspaceId, workspaceId),
      eq(opportunitiesTable.clientId, id),
    ))
    .orderBy(desc(opportunitiesTable.createdAt));

  const events = await db.select().from(clientEventsTable)
    .where(and(
      eq(clientEventsTable.workspaceId, workspaceId),
      eq(clientEventsTable.clientId, id),
    ))
    .orderBy(desc(clientEventsTable.createdAt))
    .limit(200);

  const conversationIds = conversations.map(c => c.id);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  let filesCount = 0;
  let avgResponseMinutes = 0;
  if (conversationIds.length) {
    const [fileStats] = await db.select({
      files: sql<number>`count(*) filter (where ${messagesTable.mediaType} is not null and ${messagesTable.mediaType} != 'text')::int`,
    }).from(messagesTable).where(inArray(messagesTable.conversationId, conversationIds));
    filesCount = fileStats?.files ?? 0;

    const responseRows = await db.execute(sql`
      SELECT COALESCE(AVG(diff_minutes), 0)::int as avg_minutes
      FROM (
        SELECT
          EXTRACT(EPOCH FROM (
            (SELECT m2.sent_at FROM ${messagesTable} m2
             WHERE m2.conversation_id = m1.conversation_id
             AND m2.direction = 'outbound'
             AND m2.sent_at > m1.sent_at
             ORDER BY m2.sent_at LIMIT 1)
            - m1.sent_at
          )) / 60.0 as diff_minutes
        FROM ${messagesTable} m1
        WHERE m1.direction = 'inbound' AND m1.conversation_id IN (${sql.join(conversationIds.map(cid => sql`${cid}`), sql`, `)})
      ) t
      WHERE diff_minutes IS NOT NULL AND diff_minutes < 1440
    `);
    const row = (responseRows as any).rows?.[0] ?? (responseRows as any)[0] ?? null;
    avgResponseMinutes = row?.avg_minutes ?? 0;
  }

  const quotesSentCount = tasks.filter(t => t.type === "send_quote").length;
  const salesCount = opportunities.filter(o => o.outcome === "won").length;
  // Compute totalSales dynamically from won opportunities — the DB column
  // (clients.total_sales) is kept in sync by the pipeline close/reopen routes,
  // but here we recalculate from source-of-truth so historical data is always
  // correct regardless of whether the column was updated at close time.
  const totalSales = opportunities
    .filter(o => o.outcome === "won")
    .reduce((sum, o) => sum + (o.value ?? 0), 0);

  res.json({
    ...client,
    totalSales,                               // override stale DB column
    createdAt: client.createdAt.toISOString(),
    lastContactAt: client.lastContactAt?.toISOString() ?? null,
    conversations: conversations.map(c => ({
      ...c,
      lastMessageAt: c.lastMessageAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
    })),
    tasks: tasks.map(t => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      dueAt: t.dueAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
    })),
    opportunities: opportunities.map(o => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
      expectedCloseAt: o.expectedCloseAt?.toISOString() ?? null,
    })),
    events: events.map(e => ({ ...e, createdAt: e.createdAt.toISOString() })),
    kpis: {
      conversationsCount: conversations.length,
      tasksCount: tasks.length,
      opportunitiesCount: opportunities.length,
      filesCount,
      quotesSentCount,
      salesCount,
      avgResponseMinutes,
      lastContactAt: client.lastContactAt?.toISOString() ?? null,
    },
    purchasedProducts: client.purchasedProducts ?? [],
    consultedProducts: client.consultedProducts ?? [],
  });
});

// Update client
router.patch("/clients/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [before] = await db.select().from(clientsTable)
    .where(and(eq(clientsTable.id, id), eq(clientsTable.workspaceId, workspaceId)));
  if (!before) { res.status(404).json({ error: "Not found" }); return; }

  const body = req.body;
  const update: Record<string, unknown> = {};
  const allowed = ["name", "company", "phone", "email", "province", "city", "country", "address", "position", "industry", "cuit", "website", "priority", "stage", "tags", "estimatedBilling", "notes"];
  for (const key of allowed) {
    if (body[key] !== undefined) update[key] = body[key];
  }
  if (update.phone) {
    update.phone = normalizePhone(update.phone as string);
    if (update.phone !== before.phone) {
      const [dupe] = await db.select({ id: clientsTable.id })
        .from(clientsTable)
        .where(and(
          eq(clientsTable.workspaceId, workspaceId),
          eq(clientsTable.phone, update.phone as string),
        ))
        .limit(1);
      if (dupe && dupe.id !== id) {
        res.status(409).json({ error: "Ya existe otro cliente con ese teléfono.", clientId: dupe.id });
        return;
      }
    }
  }

  const [client] = await db.update(clientsTable).set(update)
    .where(and(eq(clientsTable.id, id), eq(clientsTable.workspaceId, workspaceId)))
    .returning();
  if (!client) { res.status(404).json({ error: "Not found" }); return; }

  // If name changed, any linked conversation's display name must refresh.
  // Emit a generic event — frontend invalidates /api/conversations on receipt.
  socketEmit(workspaceId, "client:updated", { id });

  // Timeline events — one per meaningful change, so the history reads clearly
  // instead of a single generic "cliente editado" line.
  if ("priority" in update && update.priority !== before.priority) {
    await logClientEvent({ workspaceId, clientId: id, type: "priority_changed", detail: `Prioridad: ${before.priority} → ${update.priority}`, actor: "Operador" });
  }
  if ("stage" in update && update.stage !== before.stage) {
    await logClientEvent({ workspaceId, clientId: id, type: "stage_changed", detail: `Etapa: ${before.stage} → ${update.stage}`, actor: "Operador" });
  }
  if ("notes" in update && update.notes && update.notes !== before.notes) {
    await logClientEvent({ workspaceId, clientId: id, type: "note_added", detail: `Observación agregada`, actor: "Operador" });
  }
  const otherChangedKeys = Object.keys(update).filter(k => !["priority", "stage", "notes"].includes(k) && (update as any)[k] !== (before as any)[k]);
  if (otherChangedKeys.length) {
    await logClientEvent({ workspaceId, clientId: id, type: "client_edited", detail: `Cliente editado (${otherChangedKeys.join(", ")})`, actor: "Operador" });
  }

  res.json({
    ...client,
    createdAt: client.createdAt.toISOString(),
    lastContactAt: client.lastContactAt?.toISOString() ?? null,
  });
});

// Delete client
router.delete("/clients/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify client belongs to this workspace before deleting
  const [check] = await db.select({ id: clientsTable.id }).from(clientsTable)
    .where(and(eq(clientsTable.id, id), eq(clientsTable.workspaceId, workspaceId)));
  if (!check) { res.status(404).json({ error: "Not found" }); return; }

  // clientEvents.clientId is NOT NULL, so any client with history (which is
  // effectively every client — creation itself logs an event) fails the
  // delete with an FK violation unless its events are removed first. Tasks/
  // conversations/opportunities keep their own life independent of the
  // client record, so we only detach them (clientId -> null) instead of
  // deleting them — deleting a client must never silently delete tasks or
  // sales history, only its own profile + timeline.
  await db.transaction(async (tx) => {
    await tx.delete(clientEventsTable)
      .where(and(eq(clientEventsTable.clientId, id), eq(clientEventsTable.workspaceId, workspaceId)));
    await tx.update(conversationsTable).set({ clientId: null })
      .where(and(eq(conversationsTable.clientId, id), eq(conversationsTable.workspaceId, workspaceId)));
    await tx.update(tasksTable).set({ clientId: null })
      .where(and(eq(tasksTable.clientId, id), eq(tasksTable.workspaceId, workspaceId)));
    await tx.update(opportunitiesTable).set({ clientId: null })
      .where(and(eq(opportunitiesTable.clientId, id), eq(opportunitiesTable.workspaceId, workspaceId)));
    await tx.delete(clientsTable)
      .where(and(eq(clientsTable.id, id), eq(clientsTable.workspaceId, workspaceId)));
  });

  // Conversations/tasks/opportunities that referenced this client now have
  // clientId = null, so the frontend should re-fetch to show the phone
  // number again instead of the (now gone) client name.
  socketEmit(workspaceId, "client:updated", { id });
  res.status(204).end();
});

// ─── Client Profile endpoints ─────────────────────────────────────────────────

import { clientProfilesTable } from "@workspace/db";
import { computeClientProfile, computeAllProfiles } from "../services/clientProfiles";
import { syncCommercialState, runCommercialEngine } from "../services/commercialEngine";

// GET /clients/:id/profile — fetch computed commercial profile
router.get("/clients/:id/profile", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [profile] = await db.select().from(clientProfilesTable)
    .where(and(eq(clientProfilesTable.clientId, id), eq(clientProfilesTable.workspaceId, workspaceId)));
  if (!profile) { res.status(404).json({ error: "Not found — run compute first" }); return; }
  res.json({ ...profile, computedAt: profile.computedAt.toISOString() });
});

// POST /clients/:id/compute-profile — compute/refresh profile for one client
router.post("/clients/:id/compute-profile", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await computeClientProfile(workspaceId, id);
  const [profile] = await db.select().from(clientProfilesTable)
    .where(and(eq(clientProfilesTable.clientId, id), eq(clientProfilesTable.workspaceId, workspaceId)));
  res.json({ ...profile!, computedAt: profile!.computedAt.toISOString() });
});

// POST /clients/compute-profiles — (re)compute all profiles in workspace
router.post("/clients/compute-profiles", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const computed = await computeAllProfiles(workspaceId);
  res.json({ computed });
});

// POST /clients/:id/sync-commercial — full CIE run: recalculates score + keyword
// scoring + sets client.priority and client.stage from configurable thresholds.
router.post("/clients/:id/sync-commercial", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const result = await syncCommercialState(workspaceId, id);
    // Re-fetch profile so caller gets the full stored row (including new columns)
    const [profile] = await db.select().from(clientProfilesTable)
      .where(and(eq(clientProfilesTable.clientId, id), eq(clientProfilesTable.workspaceId, workspaceId)));
    res.json({
      ...profile!,
      computedAt: profile!.computedAt.toISOString(),
      // Engine extras (not all stored yet in profile row, return from result)
      keywordScore:  result.keywordScore,
      enginePriority: result.enginePriority,
      engineStage:    result.engineStage,
      appliedRules:   result.appliedRules,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Engine error" });
  }
});

// ─── POST /clients/bulk-update-names — update names from Excel ────────────────
// Accepts { excelBase64: string } — the xlsx file encoded in base64.
// Looks up each row by phone, then updates name + company for matching clients.
// Never creates new clients; only patches existing ones.
router.post("/clients/bulk-update-names", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { excelBase64 } = req.body as { excelBase64?: string };

  if (!excelBase64) {
    res.status(400).json({ error: "excelBase64 requerido" });
    return;
  }

  let XLSX: typeof import("xlsx");
  try {
    XLSX = await import("xlsx");
  } catch {
    res.status(500).json({ error: "xlsx no disponible en el servidor" });
    return;
  }

  const buffer = Buffer.from(excelBase64, "base64");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];

  if (rows.length < 2) {
    res.json({ updated: 0, notFound: 0, total: 0 });
    return;
  }

  const headers = rows[0] as string[];
  const nameIdx    = headers.indexOf("First Name");
  const companyIdx = headers.indexOf("Organization 1 - Name");
  const phoneIdx   = headers.indexOf("Phone 1 - Value");

  if (nameIdx === -1 || phoneIdx === -1) {
    res.status(400).json({
      error: 'El archivo debe tener las columnas "First Name" y "Phone 1 - Value".',
    });
    return;
  }

  const dataRows = rows.slice(1).filter(r => (r as any[])[phoneIdx]);

  let updated = 0;
  let notFound = 0;

  for (const row of dataRows) {
    const r = row as any[];
    const phone   = String(r[phoneIdx] ?? "").trim();
    const name    = String(r[nameIdx]  ?? "").trim();
    const company = companyIdx >= 0 ? String(r[companyIdx] ?? "").trim() : "";

    if (!phone || !name) continue;

    const normalizedPhone = normalizePhone(phone);

    const [client] = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.workspaceId, workspaceId),
          eq(clientsTable.phone, normalizedPhone),
        ),
      )
      .limit(1);

    if (!client) { notFound++; continue; }

    const upd: Record<string, string> = { name };
    if (company) upd.company = company;

    await db
      .update(clientsTable)
      .set(upd)
      .where(
        and(
          eq(clientsTable.id, client.id),
          eq(clientsTable.workspaceId, workspaceId),
        ),
      );

    updated++;
  }

  // Invalidate all client caches on the frontend
  socketEmit(workspaceId, "client:updated", { bulk: true });

  res.json({ updated, notFound, total: dataRows.length });
});

// ─── POST /clients/own-import — create + update + link from CRM Excel export ──
// Accepts { excelBase64: string } — the .xlsx previously exported via "Exportar Excel".
// Differences vs bulk-update-names:
//   • Creates NEW clients for phones not yet in the CRM
//   • Updates name/company/email/notes/tags on existing clients (full merge)
//   • Links unlinked conversations whose contactPhone matches an imported phone
router.post("/clients/own-import", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { excelBase64 } = req.body as { excelBase64?: string };

  if (!excelBase64) {
    res.status(400).json({ error: "excelBase64 requerido" });
    return;
  }

  let XLSX: typeof import("xlsx");
  try {
    XLSX = await import("xlsx");
  } catch {
    res.status(500).json({ error: "xlsx no disponible en el servidor" });
    return;
  }

  const buffer = Buffer.from(excelBase64, "base64");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];

  if (rawRows.length < 2) {
    res.json({ created: 0, updated: 0, linked: 0, errors: 0, total: 0 });
    return;
  }

  const headers = (rawRows[0] as string[]).map(h => String(h ?? "").trim());
  const nameIdx    = headers.findIndex(h => /^first name$/i.test(h));
  const companyIdx = headers.findIndex(h => /^organization.*name$/i.test(h));
  const phoneIdx   = headers.findIndex(h => /^phone.*value$/i.test(h));
  const emailIdx   = headers.findIndex(h => /^e-?mail.*value$/i.test(h));
  const notesIdx   = headers.findIndex(h => /^notes$/i.test(h));
  const labelsIdx  = headers.findIndex(h => /^labels$/i.test(h));

  if (phoneIdx === -1) {
    res.status(400).json({
      error: 'El archivo debe tener la columna "Phone 1 - Value". Usá el botón "Exportar Excel" del CRM para obtener el formato correcto.',
    });
    return;
  }

  const { normalizePhoneARG, applyGoogleImportRows } =
    await import("../services/googleContactsImport");
  type GoogleImportRow = import("../services/googleContactsImport").GoogleImportRow;
  const { isNull: isNullORM } = await import("drizzle-orm");

  // Load existing clients for phone-based duplicate detection
  const existingClients = await db
    .select({ id: clientsTable.id, phone: clientsTable.phone })
    .from(clientsTable)
    .where(eq(clientsTable.workspaceId, workspaceId));

  const phoneToClientId = new Map<string, number>();
  for (const c of existingClients) {
    if (c.phone) phoneToClientId.set(c.phone.replace(/^\+/, ""), c.id);
  }

  const dataRows = (rawRows.slice(1) as any[][]).filter(r => r[phoneIdx]);

  const importRows: GoogleImportRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const rawPhone = String(r[phoneIdx] ?? "").trim();
    if (!rawPhone) continue;

    const norm    = normalizePhoneARG(rawPhone);
    const phone   = norm?.normalized ?? null;
    const name    = nameIdx    >= 0 ? String(r[nameIdx]    ?? "").trim() || null : null;
    const company = companyIdx >= 0 ? String(r[companyIdx] ?? "").trim() || null : null;
    const email   = emailIdx   >= 0 ? String(r[emailIdx]   ?? "").trim() || null : null;
    const notes   = notesIdx   >= 0 ? String(r[notesIdx]   ?? "").trim() || null : null;
    const labelsRaw = labelsIdx >= 0 ? String(r[labelsIdx] ?? "").trim() : "";
    const labels = labelsRaw
      ? labelsRaw.split(/\s*:::\s*/).map((l: string) => l.trim()).filter(Boolean)
      : [];

    const digits = phone?.replace(/^\+/, "") ?? null;
    const matchedClientId = digits ? (phoneToClientId.get(digits) ?? null) : null;

    importRows.push({
      rowIndex: i,
      name: name || "Sin nombre",
      company: company ?? undefined,
      email: email ?? undefined,
      phone: phone ?? undefined,
      notes: notes ?? undefined,
      labels,
      matchedClientId,
    });
  }

  const { imported: created, updated, errors } = await applyGoogleImportRows(importRows, workspaceId);

  // Reload to capture newly created client IDs
  const allClients = await db
    .select({ id: clientsTable.id, phone: clientsTable.phone })
    .from(clientsTable)
    .where(eq(clientsTable.workspaceId, workspaceId));

  const allPhoneToClientId = new Map<string, number>();
  for (const c of allClients) {
    if (c.phone) allPhoneToClientId.set(c.phone.replace(/^\+/, ""), c.id);
  }

  // Link unlinked conversations whose contactPhone matches an imported phone
  let linked = 0;
  const processedDigits = new Set<string>();

  for (const row of importRows) {
    if (!row.phone) continue;
    const digits = row.phone.replace(/^\+/, "");
    if (processedDigits.has(digits)) continue;
    processedDigits.add(digits);

    const clientId = allPhoneToClientId.get(digits);
    if (!clientId) continue;

    const result = await db
      .update(conversationsTable)
      .set({ clientId })
      .where(
        and(
          eq(conversationsTable.workspaceId, workspaceId),
          isNullORM(conversationsTable.clientId),
          or(
            eq(conversationsTable.contactPhone, digits),
            eq(conversationsTable.contactPhone, `+${digits}`),
          ),
        ),
      )
      .returning({ id: conversationsTable.id });

    linked += result.length;
  }

  socketEmit(workspaceId, "client:updated", { bulk: true });
  res.json({ created, updated, linked, errors, total: dataRows.length });
});

// ─── POST /clients/crm-sync — two-phase SSE streaming CRM sync ───────────────
//
// Phase 1: single bulk SQL — updates lastContactAt for all clients.
//          Sends: { type:"phase", phase:1 } then { type:"phase1_complete", interactionsUpdated:N }
//
// Phase 2: per-client WhatsApp photo fetch with hard 7 s timeout + skip flag.
//          Sends: { type:"phase", phase:2 } then { type:"progress", ...PhotoStats }
//          then { type:"complete", ...PhotoStats, interactionsUpdated:N }
//
router.post("/clients/crm-sync", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { syncInteractions, syncPhotos, isRunning, setPhase, setInteractionsUpdated } =
    await import("../services/customerSync");

  // ── Concurrency guard — never run two syncs simultaneously ───────────────
  if (isRunning(workspaceId)) {
    res.status(409).json({
      running: true,
      message: "Ya existe una sincronización ejecutándose.",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // NOTE: we deliberately do NOT abort on SSE close ("close" event).
  // The sync runs to completion even if the browser disconnects.
  // The frontend can reconnect via GET /clients/crm-sync-status + polling.

  const send = (data: object) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // ── Phase 1: interactions (fast, bulk SQL) ────────────────────────────
    setPhase(workspaceId, 1);
    send({ type: "phase", phase: 1 });
    const interactionsUpdated = await syncInteractions(workspaceId);
    setInteractionsUpdated(workspaceId, interactionsUpdated);
    send({ type: "phase1_complete", interactionsUpdated });

    // ── Phase 2: photos (streaming, per-client) ───────────────────────────
    setPhase(workspaceId, 2);
    send({ type: "phase", phase: 2 });
    const finalStats = await syncPhotos(workspaceId, (stats) => {
      send({ type: "progress", ...stats });
    });

    send({ type: "complete", ...finalStats, interactionsUpdated });
  } catch (e: any) {
    send({ type: "error", message: e?.message ?? "Sync error" });
  } finally {
    res.end();
  }
});

// ─── POST /clients/crm-sync-skip — skip the client currently being processed ─
router.post("/clients/crm-sync-skip", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { requestSkip } = await import("../services/customerSync");
  requestSkip(workspaceId);
  res.json({ ok: true });
});

// ─── POST /clients/crm-sync-abort — cancel the entire running sync ────────────
router.post("/clients/crm-sync-abort", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { requestAbort } = await import("../services/customerSync");
  requestAbort(workspaceId);
  res.json({ ok: true });
});

// ─── GET /clients/:id/timeline — unified commercial timeline ──────────────────
// Returns conversations, tasks, and calendar-linked tasks merged and sorted
// by date descending. Query param ?days=90 controls the lookback window.
router.get("/clients/:id/timeline", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const days = Math.min(parseInt((req.query.days as string) || "90") || 90, 730);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [check] = await db.select({ id: clientsTable.id })
    .from(clientsTable)
    .where(and(eq(clientsTable.id, id), eq(clientsTable.workspaceId, workspaceId)));
  if (!check) { res.status(404).json({ error: "Not found" }); return; }

  const { gte: gte2, or: or2 } = await import("drizzle-orm");

  const [conversations, tasks] = await Promise.all([
    db.select({
      id: conversationsTable.id,
      lastMessageAt: conversationsTable.lastMessageAt,
      lastMessage: conversationsTable.lastMessage,
      aiSummary: conversationsTable.aiSummary,
      status: conversationsTable.status,
    }).from(conversationsTable)
      .where(and(
        eq(conversationsTable.workspaceId, workspaceId),
        eq(conversationsTable.clientId, id),
        gte2(conversationsTable.lastMessageAt, cutoff),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt))
      .limit(50),

    db.select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      priority: tasksTable.priority,
      dueAt: tasksTable.dueAt,
      createdAt: tasksTable.createdAt,
      calendarEventType: tasksTable.calendarEventType,
      googleCalendarEventId: tasksTable.googleCalendarEventId,
    }).from(tasksTable)
      .where(and(
        eq(tasksTable.workspaceId, workspaceId),
        eq(tasksTable.clientId, id),
      ))
      .orderBy(desc(tasksTable.createdAt))
      .limit(200),
  ]);

  const items: object[] = [];

  for (const conv of conversations) {
    items.push({
      type: "conversation",
      id: `conv-${conv.id}`,
      date: conv.lastMessageAt.toISOString(),
      title: conv.lastMessage ? conv.lastMessage.substring(0, 100) : "Conversación de WhatsApp",
      snippet: conv.aiSummary ?? null,
      status: conv.status,
      refId: conv.id,
    });
  }

  for (const task of tasks) {
    const isCalEvent = !!task.googleCalendarEventId && !!task.dueAt;
    const dateToUse = isCalEvent ? task.dueAt! : (task.dueAt ?? task.createdAt);
    if (dateToUse < cutoff) continue;

    if (isCalEvent) {
      items.push({
        type: "calendar_event",
        id: `cal-${task.id}`,
        date: dateToUse.toISOString(),
        title: task.title,
        snippet: task.calendarEventType ?? null,
        status: task.status,
        refId: task.id,
        calendarEventType: task.calendarEventType,
      });
    } else {
      items.push({
        type: "task",
        id: `task-${task.id}`,
        date: dateToUse.toISOString(),
        title: task.title,
        snippet: null,
        status: task.status,
        priority: task.priority,
        refId: task.id,
        dueAt: task.dueAt?.toISOString() ?? null,
      });
    }
  }

  items.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  res.json(items);
});

export default router;
