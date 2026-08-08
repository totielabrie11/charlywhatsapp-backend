import { Router } from "express";
import express from "express";
import { randomBytes } from "crypto";
import { rateLimit } from "../lib/rateLimit";
import { db } from "@workspace/db";
import {
  conversationsTable,
  messagesTable,
  tasksTable,
  clientsTable,
  activityLogTable,
  messageReactionsTable,
} from "@workspace/db";
import { getAgentsStatus } from "../services/agentValidation";
import { eq, desc, ilike, or, sql, and, inArray } from "drizzle-orm";
import * as wa from "../services/whatsapp";
import * as ai from "../services/ai";
import { emit as socketEmit } from "../lib/socket";
import { normalizePhone } from "../lib/phone";
import { logger } from "../lib/logger";
import { logClientEvent } from "../services/clientEvents";
import { createMediaLinkToken } from "../lib/mediaSignedUrl";

const API_BASE_FOR_LINKS = (process.env.APP_URL ?? "").replace(/\/$/, "");

const router = Router();

// List conversations
// Returns all conversation columns plus `clientName` (from joined clients table).
// The frontend uses `clientName ?? contactName` as the display name so renaming
// a client is reflected immediately without modifying the conversations table.
router.get("/conversations", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { status, search } = req.query as { status?: string; search?: string };

  // Base selection: all conversation columns + live client fields.
  // clientName and clientProfilePicUrl come from the joined clients table so they
  // always reflect the current client record — not a stale copy in the conversations row.
  const baseSelect = {
    conversation: conversationsTable,
    clientName: clientsTable.name,
    clientProfilePicUrl: clientsTable.profilePicUrl,
  };

  let rows: { conversation: typeof conversationsTable.$inferSelect; clientName: string | null; clientProfilePicUrl: string | null }[];

  if (search) {
    rows = await db.select(baseSelect)
      .from(conversationsTable)
      .leftJoin(clientsTable, eq(conversationsTable.clientId, clientsTable.id))
      .where(and(
        eq(conversationsTable.workspaceId, workspaceId),
        or(
          ilike(conversationsTable.contactName, `%${search}%`),
          ilike(conversationsTable.contactPhone, `%${search}%`),
          ilike(clientsTable.name, `%${search}%`),
        ),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt));
    if (status && status !== "all") {
      rows = rows.filter(r => r.conversation.status === status);
    }
  } else if (status && status !== "all") {
    rows = await db.select(baseSelect)
      .from(conversationsTable)
      .leftJoin(clientsTable, eq(conversationsTable.clientId, clientsTable.id))
      .where(and(
        eq(conversationsTable.workspaceId, workspaceId),
        eq(conversationsTable.status, status),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt));
  } else {
    rows = await db.select(baseSelect)
      .from(conversationsTable)
      .leftJoin(clientsTable, eq(conversationsTable.clientId, clientsTable.id))
      .where(eq(conversationsTable.workspaceId, workspaceId))
      .orderBy(desc(conversationsTable.lastMessageAt));
  }

  const taskCounts = await db.select({
    conversationId: tasksTable.conversationId,
    count: sql<number>`count(*)::int`,
  }).from(tasksTable)
    .where(and(
      eq(tasksTable.workspaceId, workspaceId),
      eq(tasksTable.status, "pending"),
    ))
    .groupBy(tasksTable.conversationId);

  const taskMap = new Map(taskCounts.map(t => [t.conversationId, t.count]));

  res.json(rows.map(({ conversation: c, clientName, clientProfilePicUrl }) => ({
    ...c,
    clientName: clientName ?? null,
    // Live photo from the clients table. The frontend should prefer this over
    // contactAvatar (which is a cached snapshot and can be stale after edits/imports).
    clientProfilePicUrl: clientProfilePicUrl ?? null,
    lastMessageAt: c.lastMessageAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    taskCount: taskMap.get(c.id) ?? 0,
  })));
});

const DEFAULT_MESSAGES_PAGE_SIZE = 40;
const MAX_MESSAGES_PAGE_SIZE = 200;

function clampLimit(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw));
  if (isNaN(n) || n <= 0) return fallback;
  return Math.min(n, MAX_MESSAGES_PAGE_SIZE);
}

// GET /conversations/search?q= — full-text global search across contacts, clients and messages.
// Must sit before /conversations/:id so Express doesn't swallow "search" as an id.
router.get("/conversations/search", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length < 2) { res.json([]); return; }
  const pattern = `%${q}%`;
  try {
    const [convMatches, msgMatches] = await Promise.all([
      // Search conversation metadata + linked client fields
      db.select({ id: conversationsTable.id })
        .from(conversationsTable)
        .leftJoin(clientsTable, eq(conversationsTable.clientId, clientsTable.id))
        .where(and(
          eq(conversationsTable.workspaceId, workspaceId),
          or(
            ilike(conversationsTable.contactName, pattern),
            ilike(conversationsTable.contactPhone, pattern),
            ilike(clientsTable.name, pattern),
            ilike(clientsTable.company, pattern),
            ilike(clientsTable.phone, pattern),
            ilike(clientsTable.email, pattern),
            ilike(clientsTable.industry, pattern),
            ilike(clientsTable.notes, pattern),
            ilike(clientsTable.stage, pattern),
            ilike(clientsTable.priority, pattern),
            sql`${clientsTable.tags}::text ilike ${pattern}`,
          ),
        )),
      // Search full message history + file names
      db.selectDistinct({ convId: messagesTable.conversationId })
        .from(messagesTable)
        .where(and(
          eq(messagesTable.workspaceId, workspaceId),
          or(
            ilike(messagesTable.content, pattern),
            ilike(messagesTable.mediaName, pattern),
          ),
        )),
    ]);
    const ids = [...new Set([
      ...convMatches.map(c => c.id),
      ...msgMatches.map(m => m.convId).filter((x): x is number => x !== null),
    ])];
    res.json(ids);
  } catch (e: any) {
    logger.error({ err: e }, "conversations/search failed");
    res.status(500).json({ error: e.message ?? "Error en búsqueda" });
  }
});

// Get conversation detail — returns only the most recent page of messages
// (default 40) so opening a conversation is fast regardless of history size.
// Older messages are fetched on demand via GET /conversations/:id/messages.
router.get("/conversations/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const limit = clampLimit(req.query.messagesLimit, DEFAULT_MESSAGES_PAGE_SIZE);

  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  // Fetch the last `limit + 1` messages (newest-first) to detect whether older
  // ones exist, then reverse to chronological order for the client.
  const recentDesc = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(desc(messagesTable.sentAt), desc(messagesTable.id))
    .limit(limit + 1);

  const hasMoreMessages = recentDesc.length > limit;
  const messages = recentDesc.slice(0, limit).reverse();

  // Batch-fetch reactions for this page of messages
  const msgIds = messages.map(m => m.id);
  const reactionsRows = msgIds.length > 0
    ? await db.select().from(messageReactionsTable)
        .where(and(
          eq(messageReactionsTable.workspaceId, workspaceId),
          inArray(messageReactionsTable.messageId, msgIds),
        ))
    : [];
  const reactionsMap = new Map<number, { emoji: string; senderJid: string; fromMe: boolean }[]>();
  for (const r of reactionsRows) {
    if (!r.emoji) continue;
    if (!reactionsMap.has(r.messageId)) reactionsMap.set(r.messageId, []);
    reactionsMap.get(r.messageId)!.push({ emoji: r.emoji, senderJid: r.senderJid, fromMe: r.fromMe });
  }

  const tasks = await db.select().from(tasksTable)
    .where(and(
      eq(tasksTable.workspaceId, workspaceId),
      eq(tasksTable.conversationId, id),
    ))
    .orderBy(desc(tasksTable.createdAt));

  let client = null;
  if (conv.clientId) {
    const [c] = await db.select().from(clientsTable)
      .where(and(eq(clientsTable.id, conv.clientId), eq(clientsTable.workspaceId, workspaceId)));
    client = c || null;
  }

  await db.update(messagesTable).set({ isRead: true }).where(eq(messagesTable.conversationId, id));
  await db.update(conversationsTable).set({ unreadCount: 0 })
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));

  res.json({
    ...conv,
    lastMessageAt: conv.lastMessageAt.toISOString(),
    createdAt: conv.createdAt.toISOString(),
    messages: messages.map(m => ({ ...m, sentAt: m.sentAt.toISOString(), reactions: reactionsMap.get(m.id) ?? [] })),
    hasMoreMessages,
    tasks: tasks.map(t => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      dueAt: t.dueAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
    })),
    client: client ? {
      ...client,
      createdAt: client.createdAt.toISOString(),
      lastContactAt: client.lastContactAt?.toISOString() ?? null,
    } : null,
  });
});

// Get an older page of messages (infinite scroll up). `before` is a message id
// already loaded by the client — we page by (sentAt, id) of that message so
// results are stable even when several messages share the same timestamp.
router.get("/conversations/:id/messages", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const beforeId = parseInt(String(req.query.before));
  if (isNaN(beforeId)) { res.status(400).json({ error: "before (message id) is required" }); return; }

  const limit = clampLimit(req.query.limit, DEFAULT_MESSAGES_PAGE_SIZE);

  // Verify conversation belongs to this workspace
  const [convCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!convCheck) { res.status(404).json({ error: "Not found" }); return; }

  const [anchor] = await db.select({ sentAt: messagesTable.sentAt })
    .from(messagesTable)
    .where(and(eq(messagesTable.id, beforeId), eq(messagesTable.conversationId, id)));
  if (!anchor) { res.status(404).json({ error: "Reference message not found" }); return; }

  const olderDesc = await db.select().from(messagesTable)
    .where(and(
      eq(messagesTable.conversationId, id),
      sql`(${messagesTable.sentAt}, ${messagesTable.id}) < (${anchor.sentAt}, ${beforeId})`,
    ))
    .orderBy(desc(messagesTable.sentAt), desc(messagesTable.id))
    .limit(limit + 1);

  const hasMore = olderDesc.length > limit;
  const messages = olderDesc.slice(0, limit).reverse();

  // Attach reactions
  const olderMsgIds = messages.map(m => m.id);
  const olderReactionsRows = olderMsgIds.length > 0
    ? await db.select().from(messageReactionsTable)
        .where(and(
          eq(messageReactionsTable.workspaceId, workspaceId),
          inArray(messageReactionsTable.messageId, olderMsgIds),
        ))
    : [];
  const olderReactionsMap = new Map<number, { emoji: string; senderJid: string; fromMe: boolean }[]>();
  for (const r of olderReactionsRows) {
    if (!r.emoji) continue;
    if (!olderReactionsMap.has(r.messageId)) olderReactionsMap.set(r.messageId, []);
    olderReactionsMap.get(r.messageId)!.push({ emoji: r.emoji, senderJid: r.senderJid, fromMe: r.fromMe });
  }

  res.json({
    messages: messages.map(m => ({ ...m, sentAt: m.sentAt.toISOString(), reactions: olderReactionsMap.get(m.id) ?? [] })),
    hasMore,
  });
});

// Get a single message by id — used by the frontend to append/patch a
// real-time message into an open conversation without refetching the whole thread.
router.get("/messages/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify the message's conversation belongs to this workspace.
  const [msg] = await db
    .select({ msg: messagesTable })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(conversationsTable.id, messagesTable.conversationId))
    .where(and(eq(messagesTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }

  res.json({ ...msg.msg, sentAt: msg.msg.sentAt.toISOString() });
});

// Update conversation (link client, change status/priority)
router.patch("/conversations/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const VALID_STATUSES = new Set(["active", "waiting", "unanswered", "resolved", "archived", "awaiting_quote", "complaint", "urgent"]);
  const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

  const update: Record<string, unknown> = {};

  if (req.body.status !== undefined) {
    if (!VALID_STATUSES.has(req.body.status)) { res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}` }); return; }
    update.status = req.body.status;
  }
  if (req.body.priority !== undefined) {
    if (req.body.priority !== null && !VALID_PRIORITIES.has(req.body.priority)) { res.status(400).json({ error: `Invalid priority. Must be one of: ${[...VALID_PRIORITIES].join(", ")}` }); return; }
    update.priority = req.body.priority;
  }
  if (req.body.aiSummary !== undefined) {
    update.aiSummary = typeof req.body.aiSummary === "string" ? req.body.aiSummary.slice(0, 2000) : null;
  }
  if (req.body.clientId !== undefined) {
    const clientId = req.body.clientId === null ? null : parseInt(String(req.body.clientId));
    if (req.body.clientId !== null && (isNaN(clientId as number) || (clientId as number) <= 0)) { res.status(400).json({ error: "Invalid clientId" }); return; }
    // Verify client exists and belongs to this workspace
    if (clientId !== null) {
      const [client] = await db.select({ id: clientsTable.id }).from(clientsTable)
        .where(and(eq(clientsTable.id, clientId as number), eq(clientsTable.workspaceId, workspaceId)));
      if (!client) { res.status(404).json({ error: "Client not found" }); return; }
    }
    update.clientId = clientId;
  }

  if (!Object.keys(update).length) { res.status(400).json({ error: "Nothing to update" }); return; }

  const [conv] = await db.update(conversationsTable).set(update)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .returning();
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }

  if ("clientId" in update) {
    // 0.5: log failures instead of silently swallowing them
    const desc = update.clientId
      ? `Conversación vinculada a cliente`
      : `Conversación desvinculada de cliente`;
    // Fetch name + phone + company for the linked client (used for log + auto-photo)
    let linkedCompany: string | null = null;
    let linkedName: string | null = null;
    let linkedPhone: string | null = null;
    if (update.clientId) {
      const [cl] = await db
        .select({ company: clientsTable.company, name: clientsTable.name, phone: clientsTable.phone })
        .from(clientsTable)
        .where(eq(clientsTable.id, update.clientId as number)).catch(() => []);
      linkedCompany = cl?.company ?? null;
      linkedName = cl?.name ?? null;
      linkedPhone = cl?.phone ?? null;
    }
    await db.insert(activityLogTable).values({
      workspaceId,
      type: update.clientId ? "client_linked" : "client_unlinked",
      description: desc,
      clientName: conv.contactName || null,
      companyName: linkedCompany,
      conversationId: id,
    }).catch((e) => { logger.warn({ err: e }, "Activity log insert failed on client link"); });

    // Notify all connected clients so the sidebar name updates immediately
    socketEmit(workspaceId, "conversation:updated", { id });

    // Fire-and-forget: auto-fetch WA profile photo when a client is linked
    if (update.clientId && linkedName && linkedPhone) {
      void import("../services/customerSync").then(({ fetchPhotoForClientAsync }) =>
        fetchPhotoForClientAsync(workspaceId, update.clientId as number, linkedName!, linkedPhone!)
      );
    }
  }

  res.json({ ...conv, lastMessageAt: conv.lastMessageAt.toISOString(), createdAt: conv.createdAt.toISOString() });
});

// Send reply
router.post("/conversations/:id/reply", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify conversation belongs to this workspace
  const [convCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!convCheck) { res.status(404).json({ error: "Not found" }); return; }

  const { content } = req.body as { content: string };
  if (!content?.trim()) { res.status(400).json({ error: "Content required" }); return; }

  await wa.sendMessage(workspaceId, id, content);

  const [msg] = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, id))
    .orderBy(desc(messagesTable.sentAt))
    .limit(1);

  // Enrich message_sent with contact context via conversationId — dashboard API will JOIN for names
  await db.insert(activityLogTable).values({
    workspaceId, type: "message_sent", description: "Respuesta enviada",
    clientName: null, conversationId: id,
  });

  // ── Auto-opportunity: detect commercial signals in outbound operator messages ──
  // Runs fire-and-forget so the reply is returned immediately to the frontend.
  // Only triggers when the operator's message contains a quote/price signal AND
  // the conversation is linked to a CRM client.
  const [convForOpp] = await db
    .select({ clientId: conversationsTable.clientId, contactName: conversationsTable.contactName })
    .from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);

  if (convForOpp?.clientId) {
    // Read iaEnabled + autoPipelineEnabled before firing the outbound opportunity check.
    const { aiSettingsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [oppCtrl] = await db
      .select({ iaEnabled: aiSettingsTable.iaEnabled, autoPipelineEnabled: aiSettingsTable.autoPipelineEnabled, autoPipelineMinConfidence: aiSettingsTable.autoPipelineMinConfidence })
      .from(aiSettingsTable)
      .where(eq(aiSettingsTable.workspaceId, workspaceId))
      .limit(1);
    if ((oppCtrl?.iaEnabled ?? true) && (oppCtrl?.autoPipelineEnabled ?? true)) {
      const minConf = ((oppCtrl?.autoPipelineMinConfidence ?? "medium") as "medium" | "high");
      ai.maybeCreateOpportunityFromMessage(
        convForOpp.clientId,
        content.trim(),
        convForOpp.contactName,
        workspaceId,
        id,
        "outbound",
        minConf,
      ).catch(e => logger.warn({ err: e, conversationId: id }, "Outbound auto-opp check failed"));
    }
  }

  res.status(201).json({ ...msg, sentAt: msg.sentAt.toISOString() });
});

// Fase 1: Send media (image, document, audio) — body limit 10 MB inherited from app
router.post("/conversations/:id/send-media",
  rateLimit({ max: 20, windowMs: 60_000 }),
  express.json({ limit: "15mb" }),
  async (req, res) => {
    const workspaceId = req.workspaceId!;
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    // Verify conversation belongs to this workspace
    const [convCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
      .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
    if (!convCheck) { res.status(404).json({ error: "Not found" }); return; }

    const { mediaKind, base64, mimeType, fileName, caption } = req.body as {
      mediaKind: string; base64: string; mimeType: string; fileName?: string; caption?: string;
    };

    const ALLOWED = new Set(["image", "document", "audio"]);
    if (!ALLOWED.has(mediaKind)) { res.status(400).json({ error: "mediaKind must be image | document | audio" }); return; }
    if (!base64) { res.status(400).json({ error: "base64 is required" }); return; }
    if (!mimeType) { res.status(400).json({ error: "mimeType is required" }); return; }

    // Guard: reject oversized payloads before touching the DB
    const MAX_BASE64_LEN = 15 * 1024 * 1024; // ~11 MB binary
    if (base64.length > MAX_BASE64_LEN) { res.status(413).json({ error: "Archivo demasiado grande (máx. ~11 MB)" }); return; }

    try {
      const result = await wa.sendMediaMessage(
        workspaceId,
        id,
        mediaKind as "image" | "document" | "audio",
        base64,
        mimeType,
        fileName,
        caption,
      );
      res.status(201).json(result);
    } catch (e: any) {
      logger.error({ err: e }, "send-media failed");
      res.status(500).json({ error: e.message ?? "Error al enviar el archivo" });
    }
  },
);

// Serve the raw binary for a message's media attachment (image/document/audio).
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
  "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
  "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/webm": ".webm",
  "audio/aac": ".aac", "audio/3gpp": ".3gp", "audio/amr": ".amr",
  "application/pdf": ".pdf", "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/zip": ".zip", "application/x-zip-compressed": ".zip",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "video/3gpp": ".3gp", "video/ogg": ".ogv",
};

/** Looks up a message's media within a given workspace — shared by both the
 *  Bearer-authenticated route and the signed-URL route below. */
export async function findWorkspaceMessageMedia(id: number, workspaceId: number) {
  const [row] = await db
    .select({ msg: messagesTable })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(conversationsTable.id, messagesTable.conversationId))
    .where(and(eq(messagesTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);
  return row?.msg ?? null;
}

export function sendMedia(res: express.Response, msg: NonNullable<Awaited<ReturnType<typeof findWorkspaceMessageMedia>>>, download: boolean) {
  const buffer = Buffer.from(msg.mediaData!, "base64");
  const mimeType = msg.mediaMimeType || "application/octet-stream";
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  const disposition = download ? "attachment" : "inline";
  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  const rawName = (msg.mediaName || `archivo-${msg.id}`).replace(/["\\]/g, "");
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(rawName);
  const fileName = hasExt ? rawName : rawName + (MIME_EXT[baseMime] ?? "");
  res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
  res.send(buffer);
}

// Lets the frontend embed a normal <img>/<iframe>/<audio> src or "copy link"
// instead of shipping base64 through JSON, and lets other features (forward)
// reuse the same bytes server-side without a client round-trip.
//
// This route is Bearer-authenticated (behind requireWorkspace, like every
// other /api/* route) — it is NOT meant to be used as a raw <img src>/<a
// href> from the frontend directly, since the browser has no way to attach
// an Authorization header to a request it initiates itself. The frontend
// fetches this WITH the header and turns the response into a blob: URL
// (see MediaPreviewModal.tsx) for viewing/downloading already-open media.
// For a link meant to be copied/shared/opened outside the app, use
// GET /messages/:id/media-link below instead, which hands back a
// short-lived signed URL that works as a plain link with no header needed.
router.get("/messages/:id/media", rateLimit({ max: 120, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const msg = await findWorkspaceMessageMedia(id, workspaceId);
  if (!msg || !msg.mediaData) { res.status(404).json({ error: "Media not found" }); return; }

  sendMedia(res, msg, req.query.download === "1");
});

// Generates a short-lived (15 min) signed URL for a message's media — for
// the "copiar enlace" feature and anything else that needs a real,
// standalone URL rather than a JS-mediated fetch. Still Bearer-authenticated
// (only a workspace member can mint a link), but the resulting URL itself
// carries its own signed, time-limited authorization so it works when
// pasted into a browser bar, another app, etc. See lib/mediaSignedUrl.ts.
router.get("/messages/:id/media-link", rateLimit({ max: 30, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const msg = await findWorkspaceMessageMedia(id, workspaceId);
  if (!msg || !msg.mediaData) { res.status(404).json({ error: "Media not found" }); return; }

  const token = createMediaLinkToken(id, workspaceId);
  const ttlMs = 15 * 60 * 1000;
  res.json({
    url: `${API_BASE_FOR_LINKS}/api/media/signed/${token}`,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
});

// Forward a message's media to one or more other conversations, reusing the
// already-stored bytes (no re-download/re-upload needed from the client).
router.post("/messages/:id/forward", rateLimit({ max: 20, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { targetConversationIds } = req.body as { targetConversationIds: number[] };
  if (!Array.isArray(targetConversationIds) || !targetConversationIds.length) {
    res.status(400).json({ error: "targetConversationIds is required" });
    return;
  }
  const MAX_FORWARD_TARGETS = 20;
  if (targetConversationIds.length > MAX_FORWARD_TARGETS) {
    res.status(400).json({ error: `No se puede reenviar a más de ${MAX_FORWARD_TARGETS} conversaciones a la vez` });
    return;
  }

  // Verify the source message's conversation belongs to this workspace.
  const [srcRow] = await db
    .select({ msg: messagesTable })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(conversationsTable.id, messagesTable.conversationId))
    .where(and(eq(messagesTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);
  const msg = srcRow?.msg;
  if (!msg) { res.status(404).json({ error: "Mensaje no encontrado" }); return; }

  const FORWARDABLE_MEDIA = new Set(["image", "document", "audio"]);
  const canForwardMedia   = !!msg.mediaData && !!msg.mediaType && FORWARDABLE_MEDIA.has(msg.mediaType);
  const canForwardContact = msg.mediaType === "contact" && !!msg.mediaData;
  const canForwardText    = !!msg.content?.trim();

  if (!canForwardMedia && !canForwardContact && !canForwardText) {
    res.status(400).json({ error: "El mensaje no tiene contenido que se pueda reenviar" });
    return;
  }

  const results: { conversationId: number; ok: boolean; error?: string }[] = [];
  for (const targetId of targetConversationIds) {
    // Verify each target conversation belongs to this workspace
    const [targetConv] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
      .where(and(eq(conversationsTable.id, targetId), eq(conversationsTable.workspaceId, workspaceId)));
    if (!targetConv) {
      results.push({ conversationId: targetId, ok: false, error: "Conversación no encontrada" });
      continue;
    }
    try {
      if (canForwardMedia) {
        await wa.sendMediaMessage(
          workspaceId,
          targetId,
          msg.mediaType as "image" | "document" | "audio",
          msg.mediaData!,
          msg.mediaMimeType || "application/octet-stream",
          msg.mediaName ?? undefined,
          msg.content && msg.content !== msg.mediaName ? `Reenviado: ${msg.content}` : undefined,
        );
      } else if (canForwardContact) {
        // Parse stored ParsedContact[] JSON to extract vcardRaw strings
        const parsed = JSON.parse(msg.mediaData!) as { vcardRaw?: string; fullName?: string | null }[];
        const contactPayloads = parsed
          .filter(p => !!p.vcardRaw)
          .map(p => ({
            displayName: p.fullName || "Contacto",
            vcard: p.vcardRaw!,
          }));
        if (!contactPayloads.length) throw new Error("No vCard data available to forward");
        await wa.sendContactMessage(workspaceId, targetId, contactPayloads);
      } else {
        // Text-only forward — prefix so recipient knows it was forwarded
        await wa.sendMessage(workspaceId, targetId, `↪ ${msg.content!.trim()}`);
      }
      results.push({ conversationId: targetId, ok: true });
    } catch (e: any) {
      logger.error({ err: e, targetId }, "Forward failed");
      results.push({ conversationId: targetId, ok: false, error: e.message });
    }
  }
  res.json({ results });
});

// ─── Send a CRM client as a vCard contact to a conversation ──────────────────
// POST /conversations/:id/send-contact   body: { clientIds: number[] }
function buildClientVCard(client: {
  name: string; phone: string;
  email?: string | null; company?: string | null;
}): string {
  const parts     = client.name.trim().split(/\s+/);
  const lastName  = parts.length > 1 ? parts[parts.length - 1] : "";
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : client.name;
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${client.name}`,
    `N:${lastName};${firstName};;;`,
  ];
  if (client.company) lines.push(`ORG:${client.company}`);
  if (client.phone)   lines.push(`TEL;TYPE=CELL:${client.phone}`);
  if (client.email)   lines.push(`EMAIL;TYPE=EMAIL:${client.email}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

router.post("/conversations/:id/send-contact", rateLimit({ max: 20, windowMs: 60_000 }), async (req, res) => {
  const workspaceId    = req.workspaceId!;
  const conversationId = parseInt(req.params.id as string);
  if (isNaN(conversationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Accept clientIds (array) or legacy clientId (single) for backwards compat
  let rawIds = (req.body as any).clientIds ?? (req.body as any).clientId;
  const clientIds: number[] = (Array.isArray(rawIds) ? rawIds : [rawIds])
    .map(Number)
    .filter((n: number) => !isNaN(n));
  if (!clientIds.length) {
    res.status(400).json({ error: "clientIds is required" }); return;
  }

  const [conv] = await db.select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);
  if (!conv) { res.status(404).json({ error: "Conversación no encontrada" }); return; }

  const clients = await db
    .select({ name: clientsTable.name, phone: clientsTable.phone, email: clientsTable.email, company: clientsTable.company })
    .from(clientsTable)
    .where(and(inArray(clientsTable.id, clientIds), eq(clientsTable.workspaceId, workspaceId)));
  if (!clients.length) { res.status(404).json({ error: "Clientes no encontrados" }); return; }

  try {
    const contacts = clients.map(c => ({ displayName: c.name, vcard: buildClientVCard(c) }));
    const result   = await wa.sendContactMessage(workspaceId, conversationId, contacts);
    res.json(result);
  } catch (e: any) {
    logger.error({ err: e, conversationId, workspaceId }, "Failed to send contact from CRM");
    res.status(500).json({ error: e.message ?? "Error interno" });
  }
});

// React to a message with an emoji (WhatsApp-style reaction).
// emoji = "" removes the reaction.
router.post("/messages/:id/react", rateLimit({ max: 60, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { emoji } = req.body as { emoji?: string };
  if (emoji === undefined || emoji === null) {
    res.status(400).json({ error: "emoji is required (use empty string to remove)" });
    return;
  }

  try {
    await wa.sendReaction(workspaceId, id, emoji);
    socketEmit(workspaceId, "message:reaction", { messageId: id, emoji, fromMe: true, senderJid: "me" });
    res.json({ ok: true });
  } catch (e: any) {
    logger.error({ err: e }, "Reaction failed");
    res.status(500).json({ error: e.message });
  }
});

// Suggest reply — 0.4: rate limited to 20 req/min per IP
router.post("/conversations/:id/suggest", rateLimit({ max: 20, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Verify conversation belongs to this workspace before handing off to AI service.
  const [convCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!convCheck) { res.status(404).json({ error: "Not found" }); return; }

  // BYO AI gate — suggestReply is rule-based but log readiness for transparency
  const { isAIReady, AI_DISCONNECTED_MESSAGE } = await import("../services/aiProvider");
  const { ready: suggestReady } = isAIReady(workspaceId);
  if (!suggestReady) {
    // suggestReply is rule-based — it CAN run without AI; only generateAISuggestion needs provider
    // We still return the result but annotate it if AI features are limited
  }

  const result = await ai.suggestReply(id);
  res.json(result);
});

// Delete a single message
router.delete("/conversations/:convId/messages/:msgId", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const convId = parseInt(req.params.convId);
  const msgId = parseInt(req.params.msgId);
  if (isNaN(convId) || isNaN(msgId)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify conversation belongs to this workspace
  const [convCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.id, convId), eq(conversationsTable.workspaceId, workspaceId)));
  if (!convCheck) { res.status(404).json({ error: "Not found" }); return; }

  const [msg] = await db.select().from(messagesTable)
    .where(and(eq(messagesTable.id, msgId), eq(messagesTable.conversationId, convId)))
    .limit(1);
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }

  await db.delete(messagesTable).where(eq(messagesTable.id, msgId));

  // Update last message preview
  const [lastMsg] = await db.select().from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(desc(messagesTable.sentAt))
    .limit(1);
  if (lastMsg) {
    await db.update(conversationsTable)
      .set({ lastMessage: lastMsg.content.substring(0, 120) })
      .where(and(eq(conversationsTable.id, convId), eq(conversationsTable.workspaceId, workspaceId)));
  }

  res.status(204).end();
});

// Delete conversation
router.delete("/conversations/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify conversation belongs to this workspace before deleting
  const [convCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!convCheck) { res.status(404).json({ error: "Not found" }); return; }

  // Delete messages first, then tasks, then conversation
  await db.delete(messagesTable).where(eq(messagesTable.conversationId, id));
  await db.delete(tasksTable).where(and(eq(tasksTable.conversationId, id), eq(tasksTable.workspaceId, workspaceId)));
  const [deleted] = await db.delete(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .returning();
  if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).end();
});

// ─── Start outbound conversation ──────────────────────────────────────────────
/**
 * POST /conversations/start
 * Creates (or reopens) a conversation with any phone number and sends the first message.
 * Body: { phone, contactName, message, clientId? }
 */
router.post("/conversations/start", rateLimit({ max: 20, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { phone, contactName, message, clientId, company } = req.body as {
    phone?: string; contactName?: string; message?: string; clientId?: number; company?: string;
  };

  if (!phone?.trim()) { res.status(400).json({ error: "phone es requerido" }); return; }
  if (!message?.trim()) { res.status(400).json({ error: "message es requerido" }); return; }

  const normalizedPhone = normalizePhone(phone);

  if (normalizedPhone.length < 7 || normalizedPhone.length > 15) {
    res.status(400).json({ error: "Número de teléfono inválido. Usá formato internacional sin + (ej: 5491112345678 para Argentina, o el número local como 1140688233)" });
    return;
  }

  // Resolve clientId: explicit > auto-create from name+company
  let resolvedClientId: number | null = clientId ?? null;

  if (clientId !== undefined && clientId !== null) {
    // Validate explicit clientId — must belong to this workspace
    const [client] = await db.select({ id: clientsTable.id, name: clientsTable.name })
      .from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.workspaceId, workspaceId)))
      .limit(1);
    if (!client) { res.status(404).json({ error: "Cliente no encontrado" }); return; }
  } else if (contactName?.trim()) {
    // If name (and optionally company) provided, upsert a client record so the conversation is linked
    const trimmedName = contactName.trim();
    const trimmedCompany = company?.trim() || null;

    // Check if a client with this phone already exists in this workspace
    const [existing] = await db.select({ id: clientsTable.id, company: clientsTable.company })
      .from(clientsTable)
      .where(and(
        eq(clientsTable.workspaceId, workspaceId),
        eq(clientsTable.phone, normalizedPhone),
      ))
      .limit(1);

    if (existing) {
      resolvedClientId = existing.id;
      // Fill in company if the record is missing it and the user provided one
      if (trimmedCompany && !existing.company) {
        await db.update(clientsTable)
          .set({ company: trimmedCompany })
          .where(and(eq(clientsTable.id, existing.id), eq(clientsTable.workspaceId, workspaceId)))
          .catch(() => {});
      }
    } else {
      // Create a new client record
      const [newClient] = await db.insert(clientsTable)
        .values({ workspaceId, name: trimmedName, phone: normalizedPhone, company: trimmedCompany })
        .returning({ id: clientsTable.id });
      resolvedClientId = newClient.id;
    }
  }

  try {
    const result = await wa.startConversation(
      workspaceId,
      phone.trim(),
      contactName?.trim() || phone.trim(),
      message.trim(),
      resolvedClientId,
    );

    // Log activity — result.conversationId comes from wa.startConversation
    await db.insert(activityLogTable).values({
      workspaceId,
      type: "conversation_started",
      description: `Nueva conversación iniciada`,
      clientName: contactName?.trim() || null,
      companyName: company?.trim() || null,
      conversationId: (result as any)?.conversationId ?? (result as any)?.id ?? null,
    }).catch(() => {});
    await logClientEvent({
      workspaceId,
      clientId: resolvedClientId,
      type: "conversation_started",
      detail: `Conversación iniciada con ${contactName?.trim() || phone.trim()}`,
      actor: "Operador",
    });

    res.status(201).json(result);
  } catch (e: any) {
    logger.error({ err: e }, "start conversation failed");
    res.status(500).json({ error: e.message ?? "Error al iniciar conversación" });
  }
});

// ─── Test conversation endpoints ──────────────────────────────────────────────

/**
 * GET /conversations/test/agents-status
 * Returns current agent configuration so the Prueba IA panel can display
 * agent status without making a full test call.
 */
router.get("/conversations/test/agents-status", async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const status = await getAgentsStatus(workspaceId);
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /conversations/test/inbound
 * Simulates an inbound WhatsApp message — no WA connection needed.
 * Creates a new test conversation if conversationId is not provided.
 * Only auto-replies when at least one AI agent is active and the provider key is valid.
 */
router.post("/conversations/test/inbound", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { name, phone, content, conversationId } = req.body as {
    name?: string; phone?: string; content: string; conversationId?: number;
  };
  if (!content?.trim()) { res.status(400).json({ error: "content required" }); return; }

  let conv: typeof conversationsTable.$inferSelect | undefined;

  if (conversationId) {
    const [existing] = await db.select().from(conversationsTable)
      .where(and(
        eq(conversationsTable.id, conversationId),
        eq(conversationsTable.workspaceId, workspaceId),
      ))
      .limit(1);
    if (existing) conv = existing;
  }

  if (!conv) {
    const contactName = name?.trim() || "Usuario de prueba";
    const requestedPhone = phone?.trim();
    // Unique phone: use provided phone or a cryptographically random TEST_ token.
    // The random suffix prevents same-millisecond collisions between concurrent requests.
    const contactPhone = requestedPhone || `TEST_${randomBytes(8).toString("hex")}`;

    if (requestedPhone) {
      // Atomic upsert: INSERT ... ON CONFLICT(workspace_id, contact_phone) DO UPDATE SET contact_name = EXCLUDED.contact_name
      // This avoids the race window between SELECT + INSERT that can still violate the UNIQUE constraint.
      const [upserted] = await db
        .insert(conversationsTable)
        .values({
          workspaceId,
          contactName,
          contactPhone,
          status: "active",
          lastMessage: content.trim().substring(0, 120),
          lastMessageAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [conversationsTable.workspaceId, conversationsTable.contactPhone],
          set: { contactName, status: "active" },
        })
        .returning();
      conv = upserted;
    } else {
      [conv] = await db.insert(conversationsTable).values({
        workspaceId,
        contactName,
        contactPhone,
        status: "active",
        lastMessage: content.trim().substring(0, 120),
        lastMessageAt: new Date(),
      }).returning();
    }
  }

  const text = content.trim();

  const [msg] = await db.insert(messagesTable).values({
    workspaceId,
    conversationId: conv.id,
    direction: "inbound",
    content: text,
    status: "delivered",
    isRead: true,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: text.substring(0, 120),
    lastMessageAt: new Date(),
  }).where(and(eq(conversationsTable.id, conv.id), eq(conversationsTable.workspaceId, workspaceId)));

  socketEmit(workspaceId, "message:new", { ...msg, sentAt: msg.sentAt.toISOString() });
  socketEmit(workspaceId, "conversation:updated", { id: conv.id });

  // ── Pipeline idéntico al mensaje real de WhatsApp ─────────────────────────

  // 1. Cancelar timer "sin responder" pendiente (el cliente está respondiendo)
  wa.cancelUnanswered(workspaceId, conv.id);

  // 2. Marcar como "waiting" (el operador/IA tiene que responder)
  await wa.scheduleWaiting(workspaceId, conv.id, conv.status ?? "active");

  // 3. Clasificación IA: tags (urgente, cotización, queja), urgencia, Motor Comercial,
  //    detección de agenda — exactamente igual que un mensaje entrante real.
  //    Fire-and-forget: el endpoint responde rápido y la clasificación llega por socket.
  wa.classifyMessage(workspaceId, conv.id, text, conv.contactName);

  // 4. Actividad + cronología del cliente
  try {
    await db.insert(activityLogTable).values({
      workspaceId,
      type: "message_received",
      description: `Mensaje de prueba recibido de ${conv.contactName}`,
      clientName: conv.contactName,
    });
  } catch (e) { logger.warn({ err: e }, "Test activity log insert failed"); }

  if (conv.clientId) {
    logClientEvent({
      workspaceId,
      clientId: conv.clientId,
      type: "message_received",
      detail: text.substring(0, 160),
      actor: "cliente",
    });
  }

  // ── Agent validation — only respond when an active agent with a valid provider exists ──
  const agentsStatus = await getAgentsStatus(workspaceId);
  logger.info(`[AI TEST] Agentes encontrados: ${agentsStatus.totalAgents}`);
  logger.info(`[AI TEST] Agentes activos: ${agentsStatus.activeAgents.length}`);
  logger.info(`[AI TEST] Proveedor disponible: ${agentsStatus.hasValidProvider ? "Sí" : "No"}`);

  let autoReply: { id: number; content: string; sentAt: string; aiGenerated: boolean } | null = null;
  let skipped = false;

  if (agentsStatus.activeAgents.length === 0 || !agentsStatus.hasValidProvider) {
    logger.info("[AI TEST] Respuesta omitida: NO_ACTIVE_AGENT");
    skipped = true;
  } else {
    try {
      const { generateAISuggestion } = await import("../services/ai");
      const suggestion = await generateAISuggestion(conv.id, text);
      logger.info(`[AI TEST] Modelo ejecutado: ${agentsStatus.activeAgents[0]?.provider ?? "Groq"}`);
      if (suggestion) {
        const [replyMsg] = await db.insert(messagesTable).values({
          workspaceId,
          conversationId: conv.id,
          direction: "outbound",
          content: suggestion,
          status: "sent",
          aiGenerated: true,
        }).returning();
        await db.update(conversationsTable).set({
          lastMessage: suggestion.substring(0, 120),
          lastMessageAt: new Date(),
        }).where(and(eq(conversationsTable.id, conv.id), eq(conversationsTable.workspaceId, workspaceId)));

        socketEmit(workspaceId, "message:new", { ...replyMsg, sentAt: replyMsg.sentAt.toISOString(), direction: "outbound" });
        socketEmit(workspaceId, "conversation:updated", { id: conv.id });
        autoReply = { ...replyMsg, sentAt: replyMsg.sentAt.toISOString(), aiGenerated: true };

        // 5. Después de responder automáticamente → programar "sin responder"
        await wa.scheduleUnanswered(workspaceId, conv.id);

        if (conv.clientId) {
          logClientEvent({
            workspaceId,
            clientId: conv.clientId,
            type: "message_sent",
            detail: suggestion.substring(0, 160),
            actor: "IA",
          });
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "Test auto-reply failed");
    }
  }

  res.status(201).json({
    conversationId: conv.id,
    contactName: conv.contactName,
    contactPhone: conv.contactPhone,
    message: { ...msg, sentAt: msg.sentAt.toISOString() },
    autoReply,
    skipped,
    totalAgents: agentsStatus.totalAgents,
    activeAgents: agentsStatus.activeAgents,
  });
});

/**
 * POST /conversations/:id/reply-local
 * Stores an outbound message in the DB without sending via WhatsApp.
 * Used by the test conversation sandbox.
 */
router.post("/conversations/:id/reply-local", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { content, aiGenerated } = req.body as { content: string; aiGenerated?: boolean };
  if (!content?.trim()) { res.status(400).json({ error: "content required" }); return; }

  const [conv] = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }

  const [msg] = await db.insert(messagesTable).values({
    workspaceId,
    conversationId: id,
    direction: "outbound",
    content: content.trim(),
    status: "sent",
    aiGenerated: aiGenerated === true,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: content.trim().substring(0, 120),
    lastMessageAt: new Date(),
  }).where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));

  socketEmit(workspaceId, "message:new", { ...msg, sentAt: msg.sentAt.toISOString(), direction: "outbound" });
  socketEmit(workspaceId, "conversation:updated", { id });

  res.status(201).json({ ...msg, sentAt: msg.sentAt.toISOString() });
});

// ─── Repair lastMessage previews ──────────────────────────────────────────────
// Backfills last_message for conversations where it is empty/null but messages
// exist in the DB. Safe to call multiple times (idempotent).
router.post("/conversations/repair-previews", rateLimit({ max: 5, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const result = await db.execute(sql`
    UPDATE conversations c
    SET last_message    = sub.content,
        last_message_at = sub.sent_at
    FROM (
      SELECT DISTINCT ON (conversation_id)
        conversation_id, content, sent_at
      FROM messages
      WHERE workspace_id = ${workspaceId}
      ORDER BY conversation_id, sent_at DESC
    ) sub
    WHERE c.id           = sub.conversation_id
      AND c.workspace_id = ${workspaceId}
      AND (c.last_message IS NULL OR c.last_message = '')
  `);
  res.json({ repaired: (result as any).rowCount ?? 0 });
});

// ─── Auto-sync CRM ↔ Conversations ────────────────────────────────────────────
// Incremental consistency validator.  Runs in two passes on every call:
//   Pass 1  — unlinked conversations: find a client whose normalised phone matches
//             the conversation's contactPhone and link them.
//   Pass 2  — already-linked conversations: refresh contactName + contactAvatar
//             from the live client row, and unlink if the client was deleted.
// Called automatically by the frontend on:
//   • WebSocket (re)connect — covers app init, F5, tab reopen
//   • client:updated socket event — covers create / edit / import / delete
//   • conversations:synced socket event — covers WhatsApp history sync
// All DB writes are batched into a single Promise.all so the call is fast even
// for workspaces with hundreds of conversations.
router.post("/conversations/auto-sync", rateLimit({ max: 60, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const start = Date.now();

  // Two lightweight queries — no heavy joins, no message bodies.
  const [convos, clients] = await Promise.all([
    db.select({
      id: conversationsTable.id,
      contactPhone: conversationsTable.contactPhone,
      clientId: conversationsTable.clientId,
      contactName: conversationsTable.contactName,
      contactAvatar: conversationsTable.contactAvatar,
    }).from(conversationsTable).where(eq(conversationsTable.workspaceId, workspaceId)),
    db.select({
      id: clientsTable.id,
      name: clientsTable.name,
      phone: clientsTable.phone,
      profilePicUrl: clientsTable.profilePicUrl,
    }).from(clientsTable).where(eq(clientsTable.workspaceId, workspaceId)),
  ]);

  // Build lookup maps in a single pass over clients
  const clientByPhone = new Map<string, { id: number; name: string; profilePicUrl: string | null }>();
  const clientById    = new Map<number, { name: string; profilePicUrl: string | null }>();
  for (const c of clients) {
    const key = normalizePhone(c.phone);
    if (key) clientByPhone.set(key, { id: c.id, name: c.name, profilePicUrl: c.profilePicUrl ?? null });
    clientById.set(c.id, { name: c.name, profilePicUrl: c.profilePicUrl ?? null });
  }

  let reviewed       = 0;
  let corrected      = 0;
  let linked         = 0;
  let alreadyCorrect = 0;
  const failures: Array<{ convId: number; phone: string; reason: string }> = [];

  // Collect all changes before writing so we can batch
  const updates: Array<{ id: number; set: Record<string, unknown> }> = [];

  for (const conv of convos) {
    reviewed++;
    const rawPhone = conv.contactPhone ?? "";
    const key = normalizePhone(rawPhone);

    if (!key) {
      failures.push({ convId: conv.id, phone: rawPhone, reason: "telefono_no_normalizable" });
      continue;
    }

    if (conv.clientId === null) {
      // ── Pass 1: unlinked ────────────────────────────────────────────────────
      const match = clientByPhone.get(key);
      if (!match) continue; // no client for this phone, leave as-is
      updates.push({
        id: conv.id,
        set: {
          clientId: match.id,
          contactName: match.name,
          ...(match.profilePicUrl ? { contactAvatar: match.profilePicUrl } : {}),
        },
      });
      linked++;
      corrected++;
    } else {
      // ── Pass 2: already linked ──────────────────────────────────────────────
      const current = clientById.get(conv.clientId);
      if (!current) {
        // Client was deleted — detach the conversation gracefully
        updates.push({ id: conv.id, set: { clientId: null } });
        failures.push({ convId: conv.id, phone: key, reason: "cliente_eliminado_desvinculado" });
        corrected++;
      } else {
        const needsName   = conv.contactName !== current.name;
        const needsAvatar = !!current.profilePicUrl && conv.contactAvatar !== current.profilePicUrl;
        if (needsName || needsAvatar) {
          updates.push({
            id: conv.id,
            set: {
              contactName: current.name,
              ...(current.profilePicUrl ? { contactAvatar: current.profilePicUrl } : {}),
            },
          });
          corrected++;
        } else {
          alreadyCorrect++;
        }
      }
    }
  }

  // Batch-write all changes in parallel
  if (updates.length > 0) {
    await Promise.all(updates.map((u) =>
      db.update(conversationsTable)
        .set(u.set)
        .where(and(eq(conversationsTable.id, u.id), eq(conversationsTable.workspaceId, workspaceId)))
    ));
  }

  const durationMs = Date.now() - start;

  logger.info({
    workspaceId, reviewed, corrected, linked, alreadyCorrect,
    failures: failures.length, durationMs,
  }, `[AUDIT CRM] Conversaciones revisadas: ${reviewed} | Corregidas: ${corrected} | Vinculadas: ${linked} | Ya correctas: ${alreadyCorrect} | Tiempo: ${durationMs}ms`);

  for (const f of failures) {
    logger.info({ workspaceId, convId: f.convId, phone: f.phone },
      `[AUDIT CRM] Sin vincular (${f.reason}): conv ${f.convId} — ${f.phone}`);
  }

  res.json({ reviewed, corrected, linked, alreadyCorrect, failures, durationMs });
});

// ─── Sync conversations ↔ clients ─────────────────────────────────────────────
// Matches every conversation's phone number against the clients table.
// • Match found  → sets clientId + overwrites contactName with the client's name.
// • No match     → leaves the conversation untouched (UI shows "Sin agendar" badge).
router.post("/conversations/sync-clients", rateLimit({ max: 10, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;

  // Load all conversations and clients in two queries
  const [convos, clients] = await Promise.all([
    db.select({
      id: conversationsTable.id,
      contactPhone: conversationsTable.contactPhone,
      clientId: conversationsTable.clientId,
    }).from(conversationsTable).where(eq(conversationsTable.workspaceId, workspaceId)),
    db.select({ id: clientsTable.id, name: clientsTable.name, phone: clientsTable.phone })
      .from(clientsTable).where(eq(clientsTable.workspaceId, workspaceId)),
  ]);

  // Build phone → client lookup (canonical digits-only key)
  const clientByPhone = new Map<string, { id: number; name: string }>();
  for (const c of clients) {
    const key = normalizePhone(c.phone);
    if (key) clientByPhone.set(key, { id: c.id, name: c.name });
  }

  let matched = 0;
  let unchanged = 0;

  for (const conv of convos) {
    const key = normalizePhone(conv.contactPhone ?? "");
    const client = clientByPhone.get(key);

    if (client) {
      // Only write when something actually changes to avoid noise
      if (conv.clientId !== client.id) {
        await db.update(conversationsTable)
          .set({ clientId: client.id, contactName: client.name })
          .where(and(
            eq(conversationsTable.id, conv.id),
            eq(conversationsTable.workspaceId, workspaceId),
          ));
        matched++;
      } else {
        unchanged++;
      }
    }
    // No client match → leave as-is; the UI badge handles the visual distinction.
  }

  res.json({ matched, unchanged, total: convos.length });
});

// ─── Analyze conversation (deep LLM — Analizar button) ───────────────────────
// Returns a rich commercial-intelligence panel WITHOUT creating tasks.
// Task creation happens only when the user clicks "Guardar tarea" in the panel.
router.post("/conversations/:id/analyze", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [convOwnerCheck] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!convOwnerCheck) { res.status(404).json({ error: "Not found" }); return; }

  // BYO AI gate — analyzeConversationDeep calls the LLM; block if not configured
  const { isAIReady: checkAI, AI_DISCONNECTED_MESSAGE: aiMsg } = await import("../services/aiProvider");
  const { ready: analyzeReady, reason: analyzeReason } = checkAI(workspaceId);
  if (!analyzeReady) {
    res.status(200).json({
      actionType: "task",
      nextAction: aiMsg,
      suggestedDate: null,
      closeProbability: "media",
      risks: ["IA desconectada — configurá un proveedor en Ajustes → Configurar IA"],
      nextStep: aiMsg,
      task: null,
      clientClassification: null,
      _aiDisconnected: true,
      _reason: analyzeReason,
    });
    return;
  }

  // Optional: specific message IDs that are currently visible in the UI
  const { visibleMessageIds } = req.body as { visibleMessageIds?: number[] };

  let visibleMessages: { id: number; content: string; direction: string; sentAt: string }[] | undefined;
  if (Array.isArray(visibleMessageIds) && visibleMessageIds.length > 0) {
    const { asc } = await import("drizzle-orm");
    const msgs = await db
      .select({
        id: messagesTable.id,
        content: messagesTable.content,
        direction: messagesTable.direction,
        sentAt: messagesTable.sentAt,
      })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.conversationId, id),
        inArray(messagesTable.id, visibleMessageIds),
      ))
      .orderBy(asc(messagesTable.sentAt));

    visibleMessages = msgs.map(m => ({
      id: m.id,
      content: m.content ?? "",
      direction: m.direction ?? "inbound",
      sentAt: m.sentAt?.toISOString() ?? new Date().toISOString(),
    }));
  }

  const analysis = await ai.analyzeConversationDeep(id, visibleMessages);
  res.json(analysis);
});

// ─── Save task from Analizar panel (with duplicate detection) ─────────────────
router.post("/conversations/:id/analyze/save-task", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { title, description, dueAt, priority, type, motif, force, overwrite } = req.body as {
    title: string;
    description?: string;
    dueAt?: string | null;
    priority?: "high" | "medium" | "low";
    type?: string;
    motif?: string;
    force?: boolean;
    overwrite?: boolean;
  };

  if (!title?.trim()) { res.status(400).json({ error: "title required" }); return; }

  const [conv] = await db.select({ clientId: conversationsTable.clientId, clientName: clientsTable.name })
    .from(conversationsTable)
    .leftJoin(clientsTable, eq(conversationsTable.clientId, clientsTable.id))
    .where(and(eq(conversationsTable.id, id), eq(conversationsTable.workspaceId, workspaceId)));
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  const parsedDue = dueAt ? new Date(dueAt) : null;
  const safePriority = (["high", "medium", "low"].includes(priority ?? "") ? priority : "medium") as "high" | "medium" | "low";
  const safeDescription = description?.trim() || (motif ? `Contexto: "${motif}"` : null);

  // Duplicate detection: any pending task linked to this conversation
  const existingTasks = await db.select({
    id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, dueAt: tasksTable.dueAt,
  })
    .from(tasksTable)
    .where(and(
      eq(tasksTable.workspaceId, workspaceId),
      eq(tasksTable.conversationId, id),
      eq(tasksTable.status, "pending"),
    ));

  // ── Overwrite: update the existing pending task with the new data ──────────
  if (overwrite && existingTasks.length > 0) {
    const existing = existingTasks[0];
    const [task] = await db.update(tasksTable)
      .set({
        title: title.trim(),
        description: safeDescription,
        priority: safePriority,
        type: type || "other",
        dueAt: parsedDue,
      })
      .where(and(eq(tasksTable.id, existing.id), eq(tasksTable.workspaceId, workspaceId)))
      .returning();

    await logClientEvent({
      workspaceId,
      clientId: conv?.clientId,
      type: "task_updated",
      detail: `Tarea sobrescrita por IA (Analizar): ${task.title}`,
      actor: "IA",
      relatedType: "task",
      relatedId: task.id,
    });

    await db.insert(activityLogTable).values({
      workspaceId,
      type: "task_updated",
      description: `Tarea sobrescrita desde análisis IA: ${task.title}`,
      clientName: conv?.clientName ?? null,
      conversationId: id,
    });

    res.json({ task: { id: task.id, title: task.title }, overwritten: true });
    return;
  }

  // ── Duplicate warning (neither force nor overwrite) ───────────────────────
  if (!force && existingTasks.length > 0) {
    const dup = existingTasks[0];
    res.json({
      duplicate: {
        id: dup.id,
        title: dup.title,
        status: dup.status,
        dueAt: dup.dueAt?.toISOString() ?? null,
      },
    });
    return;
  }

  // ── Create new task ───────────────────────────────────────────────────────
  const [task] = await db.insert(tasksTable).values({
    workspaceId,
    title: title.trim(),
    description: safeDescription,
    priority: safePriority,
    type: type || "other",
    status: "pending",
    conversationId: id,
    clientId: conv?.clientId ?? null,
    dueAt: parsedDue,
  }).returning();

  await logClientEvent({
    workspaceId,
    clientId: conv?.clientId,
    type: "task_created",
    detail: `Tarea creada por IA (Analizar): ${task.title}`,
    actor: "IA",
    relatedType: "task",
    relatedId: task.id,
  });

  await db.insert(activityLogTable).values({
    workspaceId,
    type: "task_created",
    description: `Tarea creada desde análisis IA: ${task.title}`,
    clientName: conv?.clientName ?? null,
    conversationId: id,
  });

  res.json({
    task: {
      ...task,
      clientName: conv?.clientName ?? null,
      createdAt: task.createdAt.toISOString(),
      dueAt: task.dueAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
    },
  });
});

export default router;
