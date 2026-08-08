import { rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { normalizePhone } from "../lib/phone";
import { parseVCards, contactDisplayName } from "../utils/vcard";
import { db } from "@workspace/db";
import { whatsappConfigTable, waCredentialsTable, waInstanceLockTable, conversationsTable, messagesTable, activityLogTable, aiSettingsTable, messageReactionsTable, clientsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { emit } from "../lib/socket";
import { logClientEvent } from "./clientEvents";

export type WaState =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "connected"
  | "reconnecting"
  | "session_restored"
  | "session_invalid"
  | "pairing_code_pending"  // code generated, socket closed, waiting for user to enter it in WhatsApp
  | "error";

interface WaEvent {
  time: string;
  event: string;
}

// Pending auto-reply timer entry (solidario mode)
interface PendingReply {
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  cancelled: boolean;
}

// Per-workspace state
interface WhatsAppManagerState {
  state: WaState;
  qrCode: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  autoReply: boolean;
  travelMode: boolean;
  /** Agent mode: 'manual' | 'solidario' | 'autonomo' | 'noche' */
  agentMode: string;
  connectedAt: string | null;
  lastError: string | null;
  client: unknown;
  connectingTimer: ReturnType<typeof setTimeout> | null;

  // Per-workspace auth socket tracking
  authSocket: any;
  authMethod: "qr" | "pairing" | null;

  // Per-workspace instance lock
  lockHeld: boolean;
  lockHeartbeatTimer: ReturnType<typeof setInterval> | null;

  // Per-workspace connection generation counter
  connectGeneration: number;

  // Per-workspace LID → real JID maps
  lidToJid: Map<string, string>;
  deferredLidMessages: Array<{ sock: any; msg: any; lid: string }>;

  // Per-workspace pending timers
  pendingAutoReplies: Map<number, PendingReply>;
  pendingUnanswered: Map<number, ReturnType<typeof setTimeout>>;
  pendingWaiting: Map<number, ReturnType<typeof setTimeout>>;

  // Per-workspace event log
  eventLog: WaEvent[];

  // Per-workspace conflict tracking
  recentConflicts: number[];

  // Per-workspace flushing mutex
  flushing: boolean;

  // Per-workspace shutdown flag
  isShuttingDown: boolean;

  // Connection monitor
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastMessageReceivedAt: Date | null;
  lastSentAt: Date | null;
  lastSentPhone: string | null;
  disconnectCode: number | null;
  disconnectReason: string | null;
  /** Accumulated offline time in ms across all disconnections this session */
  offlineDurationMs: number;
  /** Capped at 50 entries — newest last */
  connectionLog: Array<{ type: "connected" | "disconnected"; at: string; offlineDurationMs?: number }>;
}

// ── Per-workspace state map ───────────────────────────────────────────────────
const _workspaceStates = new Map<number, WhatsAppManagerState>();

function getOrCreateState(workspaceId: number): WhatsAppManagerState {
  if (_workspaceStates.has(workspaceId)) return _workspaceStates.get(workspaceId)!;
  const s: WhatsAppManagerState = {
    state: "disconnected",
    qrCode: null,
    pairingCode: null,
    phoneNumber: null,
    displayName: null,
    autoReply: false,
    travelMode: false,
    agentMode: "manual",
    connectedAt: null,
    lastError: null,
    client: null,
    connectingTimer: null,
    authSocket: null,
    authMethod: null,
    lockHeld: false,
    lockHeartbeatTimer: null,
    connectGeneration: 0,
    lidToJid: new Map(),
    deferredLidMessages: [],
    pendingAutoReplies: new Map(),
    pendingUnanswered: new Map(),
    pendingWaiting: new Map(),
    eventLog: [],
    recentConflicts: [],
    flushing: false,
    isShuttingDown: false,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastMessageReceivedAt: null,
    lastSentAt: null,
    lastSentPhone: null,
    disconnectCode: null,
    disconnectReason: null,
    offlineDurationMs: 0,
    connectionLog: [],
  };
  _workspaceStates.set(workspaceId, s);
  return s;
}

// ── Auth dir per workspace ────────────────────────────────────────────────────
const BASE_AUTH_DIR = process.env["WA_AUTH_DIR"] ?? resolve(process.cwd(), ".wa_auth");
const MAX_EVENTS = 100;
const CONNECTING_TIMEOUT_MS = 60_000;

/**
 * Returns the per-workspace auth directory path.
 * Each workspace stores its Baileys session under its own subdirectory so
 * multiple workspaces never collide on the filesystem.
 */
function getAuthDir(workspaceId: number): string {
  return join(BASE_AUTH_DIR, `workspace_${workspaceId}`);
}

/**
 * Enable verbose DEBUG logging for the WhatsApp pairing / socket lifecycle.
 * Set the environment variable DEBUG_WA=true to activate.
 */
const DEBUG_WA = process.env["DEBUG_WA"] === "true";

function debugLog(workspaceId: number, msg: string, data?: Record<string, unknown>) {
  if (!DEBUG_WA) return;
  logger.info({ ...(data ?? {}), debugWA: true, workspaceId }, `[DEBUG-WA][ws:${workspaceId}] ${msg}`);
  addEvent(workspaceId, `[DEBUG] ${msg}${data ? " — " + JSON.stringify(data) : ""}`);
}

// ── DB-backed credential persistence ─────────────────────────────────────────

/**
 * Restore Baileys auth files from the database backup for a specific workspace.
 */
async function _restoreCredsFromDb(workspaceId: number): Promise<boolean> {
  try {
    const [row] = await db.select().from(waCredentialsTable)
      .where(eq(waCredentialsTable.workspaceId, workspaceId))
      .limit(1);
    if (!row?.data) return false;
    const files: Record<string, string> = JSON.parse(row.data);
    if (Object.keys(files).length === 0) return false;
    const authDir = getAuthDir(workspaceId);
    await mkdir(authDir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      const base = filename.replace(/^.*[/\\]/, "");
      if (base !== filename || filename.includes("..") || !/^[\w.\-]+\.json$/.test(filename)) {
        logger.warn({ filename, workspaceId }, "Skipping credential file with unsafe name during restore");
        continue;
      }
      await writeFile(join(authDir, filename), content, "utf8");
    }
    logger.info({ fileCount: Object.keys(files).length, workspaceId }, "Sesión encontrada — credenciales restauradas desde base de datos");
    return true;
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "No se pudieron restaurar las credenciales desde la base de datos");
    return false;
  }
}

/**
 * Serialise every JSON file in the workspace's auth dir and save to the database.
 */
async function _backupCredsToDB(workspaceId: number): Promise<void> {
  try {
    const authDir = getAuthDir(workspaceId);
    const files = await readdir(authDir).catch(() => [] as string[]);
    const data: Record<string, string> = {};
    for (const file of files) {
      if (file.endsWith(".json")) {
        data[file] = await readFile(join(authDir, file), "utf8");
      }
    }
    const json = JSON.stringify(data);
    const [existing] = await db.select({ id: waCredentialsTable.id })
      .from(waCredentialsTable)
      .where(eq(waCredentialsTable.workspaceId, workspaceId))
      .limit(1);
    if (existing) {
      await db.update(waCredentialsTable)
        .set({ data: json, updatedAt: new Date() })
        .where(eq(waCredentialsTable.id, existing.id));
    } else {
      await db.insert(waCredentialsTable).values({ data: json, workspaceId });
    }
    logger.info({ fileCount: Object.keys(data).length, workspaceId }, "Sesión persistida en base de datos");
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "No se pudieron persistir las credenciales en la base de datos");
  }
}

/**
 * Wipe both the local auth dir files and the database backup for a workspace.
 */
async function _clearAllCredentials(workspaceId: number): Promise<void> {
  const authDir = getAuthDir(workspaceId);
  try {
    await rm(authDir, { recursive: true, force: true });
    await mkdir(authDir, { recursive: true });
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "No se pudo limpiar el directorio de credenciales");
  }
  try {
    await db.delete(waCredentialsTable).where(eq(waCredentialsTable.workspaceId, workspaceId));
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "No se pudo limpiar el backup de credenciales en la base de datos");
  }
}

// ── Graceful shutdown & conflict backoff ─────────────────────────────────────
const CONFLICT_DISCONNECT_CODE = 440;

/** Records a stream-conflict close and returns the backoff delay (ms) to use. */
function _reconnectDelayMs(workspaceId: number, statusCode: number | undefined): number {
  const ws = getOrCreateState(workspaceId);
  const now = Date.now();
  if (statusCode === CONFLICT_DISCONNECT_CODE) {
    while (ws.recentConflicts.length && now - ws.recentConflicts[0] > 60_000) ws.recentConflicts.shift();
    ws.recentConflicts.push(now);
    const n = ws.recentConflicts.length;
    const delay = n <= 1 ? 8_000 : n === 2 ? 20_000 : 45_000;
    return delay + Math.floor(Math.random() * 2000);
  }
  return 5_000;
}

/**
 * Close any active/auth WhatsApp socket cleanly for a workspace.
 */
export async function shutdownWhatsApp(): Promise<void> {
  // Iterate all known workspaces
  const workspaceIds = Array.from(_workspaceStates.keys());
  // Also query DB to find any workspaces with config that weren't loaded in-memory
  try {
    const rows = await db.select({ workspaceId: whatsappConfigTable.workspaceId }).from(whatsappConfigTable);
    for (const r of rows) {
      if (!workspaceIds.includes(r.workspaceId)) workspaceIds.push(r.workspaceId);
    }
  } catch (_) {}

  await Promise.all(workspaceIds.map(wid => _shutdownWorkspace(wid)));
}

async function _shutdownWorkspace(workspaceId: number): Promise<void> {
  const ws = getOrCreateState(workspaceId);
  if (ws.isShuttingDown) return;
  ws.isShuttingDown = true;
  if (ws.connectingTimer) { clearTimeout(ws.connectingTimer); ws.connectingTimer = null; }
  try { await _killAuthSocket(workspaceId); } catch (_) {}
  try { await _closeSocket(workspaceId); } catch (_) {}
  try { await _releaseLock(workspaceId); } catch (_) {}
  addEvent(workspaceId, "Apagado prolijo — sesión de WhatsApp liberada para el nuevo despliegue.");
}

// ── Single-instance lock (DB-backed, per workspace) ──────────────────────────
const _instanceId = randomUUID();
const LOCK_TTL_MS = 25_000;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_RETRY_MS = 8_000;

async function _acquireOrRenewLock(workspaceId: number): Promise<boolean> {
  try {
    const result: any = await db.execute(sql`
      INSERT INTO wa_instance_lock (workspace_id, holder_id, heartbeat_at)
      VALUES (${workspaceId}, ${_instanceId}, now())
      ON CONFLICT (workspace_id) DO UPDATE
        SET holder_id = ${_instanceId}, heartbeat_at = now()
        WHERE wa_instance_lock.holder_id = ${_instanceId}
           OR now() - wa_instance_lock.heartbeat_at > (${LOCK_TTL_MS}::int * interval '1 millisecond')
      RETURNING workspace_id;
    `);
    const rows = result.rows ?? result;
    const won = Array.isArray(rows) && rows.length > 0;
    const ws = getOrCreateState(workspaceId);
    ws.lockHeld = won;
    return won;
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "No se pudo verificar el lock de instancia de WhatsApp");
    return false;
  }
}

async function _releaseLock(workspaceId: number): Promise<void> {
  const ws = getOrCreateState(workspaceId);
  if (ws.lockHeartbeatTimer) { clearInterval(ws.lockHeartbeatTimer); ws.lockHeartbeatTimer = null; }
  if (!ws.lockHeld) return;
  ws.lockHeld = false;
  try {
    await db.execute(sql`DELETE FROM wa_instance_lock WHERE workspace_id = ${workspaceId} AND holder_id = ${_instanceId};`);
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "No se pudo liberar el lock de instancia de WhatsApp");
  }
}

function _startLockHeartbeat(workspaceId: number): void {
  const ws = getOrCreateState(workspaceId);
  if (ws.lockHeartbeatTimer) return;
  ws.lockHeartbeatTimer = setInterval(() => {
    if (ws.isShuttingDown) return;
    void _acquireOrRenewLock(workspaceId);
  }, LOCK_HEARTBEAT_MS);
}

// ── LID → real JID helpers ────────────────────────────────────────────────────

async function _resolveLidViaSignalStore(sock: any, lid: string): Promise<string | null> {
  try {
    const pn: string | null = await sock?.signalRepository?.lidMapping?.getPNForLID?.(lid);
    if (pn) {
      const bareNumber = pn.split("@")[0].split(":")[0];
      return `${bareNumber}@s.whatsapp.net`;
    }
  } catch (e) {
    logger.debug({ err: e, lid }, "signalRepository.lidMapping.getPNForLID lookup failed");
  }
  return null;
}

function _indexContacts(workspaceId: number, contacts: any[]) {
  const ws = getOrCreateState(workspaceId);
  for (const c of contacts) {
    if (c?.lid && c?.id?.endsWith("@s.whatsapp.net")) {
      ws.lidToJid.set(c.lid, c.id);
    }
  }
  if (ws.deferredLidMessages.length > 0) {
    const toProcess = ws.deferredLidMessages.splice(0);
    for (const { sock, msg, lid } of toProcess) {
      if (ws.lidToJid.has(lid)) {
        logger.info({ lid, workspaceId }, "Re-processing deferred @lid message after contact map populated");
        sock.ev.emit("messages.upsert", { type: "notify", messages: [msg] });
      } else {
        logger.warn({ lid, workspaceId }, "Deferred @lid message still unresolvable after contacts.set — discarding");
      }
    }
  }
}

// ── Pending auto-reply helpers ────────────────────────────────────────────────

/** Cancel a scheduled solidario auto-reply (e.g. because the operator typed first). */
export function cancelPendingAutoReply(workspaceId: number, conversationId: number): void {
  const ws = getOrCreateState(workspaceId);
  const pending = ws.pendingAutoReplies.get(conversationId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.cancelled = true;
    pending.resolve();
    ws.pendingAutoReplies.delete(conversationId);
    logger.info({ conversationId, workspaceId }, "Solidario auto-reply cancelled (operator sent first)");
  }
}

export function cancelUnanswered(workspaceId: number, conversationId: number): void {
  const ws = getOrCreateState(workspaceId);
  const timer = ws.pendingUnanswered.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    ws.pendingUnanswered.delete(conversationId);
    logger.debug({ conversationId, workspaceId }, "Pending unanswered timer cancelled (client replied)");
  }
}

export async function scheduleUnanswered(workspaceId: number, conversationId: number): Promise<void> {
  cancelUnanswered(workspaceId, conversationId);
  const ws = getOrCreateState(workspaceId);

  let delayMs = 0;
  try {
    const { aiSettingsTable: ais } = await import("@workspace/db");
    const [s] = await db.select({ delay: ais.unansweredDelaySeconds }).from(ais).limit(1);
    delayMs = ((s?.delay ?? 0)) * 1000;
  } catch (e) {
    logger.warn({ err: e }, "Could not read unansweredDelaySeconds — defaulting to immediate");
  }

  const AUTO_STATUSES = ["active", "waiting", "unanswered"] as const;

  const applyUnanswered = async () => {
    ws.pendingUnanswered.delete(conversationId);
    await db.update(conversationsTable)
      .set({ status: "unanswered" })
      .where(and(
        eq(conversationsTable.id, conversationId),
        inArray(conversationsTable.status, [...AUTO_STATUSES]),
      ));
    emit(workspaceId, "conversation:updated", { id: conversationId });
  };

  if (delayMs <= 0) {
    await applyUnanswered();
  } else {
    const timer = setTimeout(() => {
      applyUnanswered().catch(e => logger.error({ err: e }, "scheduleUnanswered timer failed"));
    }, delayMs);
    ws.pendingUnanswered.set(conversationId, timer);
  }
}

const RESOLVED_KEYWORDS = [
  "acá está", "aca esta", "te envío", "te envio", "te mando", "adjunto",
  "presupuesto", "cotización lista", "cotizacion lista", "encontré", "encontre",
  "le paso", "te paso", "solucionado", "resuelto", "queda listo", "ya está",
  "ya esta", "lo conseguí", "lo consegui", "te lo mando", "ya lo tenemos",
  "confirmado", "listo", "perfecto, queda",
  // Local/regional variants
  "te mandé", "te mande", "ya lo enviamos", "ya enviamos",
  "está listo", "esta listo", "ahí va", "ahi va",
  "ya fue", "ya salió", "ya salio", "mandé", "mande",
  "te lo pasé", "te lo pase", "acá va", "aca va",
  "ya está disponible", "ya esta disponible",
];

async function maybeMarkResolved(workspaceId: number, conversationId: number, content: string): Promise<void> {
  try {
    const hasClosingKeyword = RESOLVED_KEYWORDS.some(kw => content.toLowerCase().includes(kw.toLowerCase()));
    if (!hasClosingKeyword) return;

    const [ais] = await db.select({ agentMode: aiSettingsTable.agentMode, tagAutomation: aiSettingsTable.tagAutomation, iaEnabled: aiSettingsTable.iaEnabled }).from(aiSettingsTable).where(eq(aiSettingsTable.workspaceId, workspaceId)).limit(1);
    if (!ais || ais.agentMode === "manual") return;
    // Respect master IA switch
    if (ais.iaEnabled === false) return;
    const resolvedEnabled = (ais.tagAutomation as { resolved?: boolean } | null)?.resolved ?? true;
    if (!resolvedEnabled) return;

    const updated = await db.update(conversationsTable)
      .set({ status: "resolved" })
      .where(and(
        eq(conversationsTable.id, conversationId),
        inArray(conversationsTable.status, ["awaiting_quote", "complaint"]),
      ))
      .returning({ id: conversationsTable.id });

    if (updated.length) {
      emit(workspaceId, "conversation:updated", { id: conversationId });
      logger.info({ conversationId, workspaceId }, "Conversation auto-marked as resolved after outbound message");
    }
  } catch (e) {
    logger.warn({ err: e, conversationId, workspaceId }, "maybeMarkResolved failed");
  }
}

function cancelWaiting(workspaceId: number, conversationId: number): void {
  const ws = getOrCreateState(workspaceId);
  const timer = ws.pendingWaiting.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    ws.pendingWaiting.delete(conversationId);
    logger.debug({ conversationId, workspaceId }, "Pending waiting timer cancelled (operator replied)");
  }
}

export async function scheduleWaiting(workspaceId: number, conversationId: number, currentStatus: string): Promise<void> {
  cancelWaiting(workspaceId, conversationId);
  const ws = getOrCreateState(workspaceId);

  const AUTO_STATUSES = ["active", "waiting", "unanswered"] as const;
  if (!(AUTO_STATUSES as readonly string[]).includes(currentStatus)) {
    emit(workspaceId, "conversation:updated", { id: conversationId });
    return;
  }

  let delayMs = 0;
  try {
    const { aiSettingsTable: ais } = await import("@workspace/db");
    const [s] = await db.select({ delay: (ais as any).waitingDelaySeconds }).from(ais).limit(1);
    delayMs = ((s?.delay ?? 0)) * 1000;
  } catch (e) {
    logger.warn({ err: e }, "Could not read waitingDelaySeconds — defaulting to immediate");
  }

  const applyWaiting = async () => {
    ws.pendingWaiting.delete(conversationId);
    await db.update(conversationsTable)
      .set({ status: "waiting" })
      .where(and(
        eq(conversationsTable.id, conversationId),
        inArray(conversationsTable.status, [...AUTO_STATUSES]),
      ));
    emit(workspaceId, "conversation:updated", { id: conversationId });
  };

  if (delayMs <= 0) {
    await applyWaiting();
  } else {
    const timer = setTimeout(() => {
      applyWaiting().catch(e => logger.error({ err: e }, "scheduleWaiting timer failed"));
    }, delayMs);
    ws.pendingWaiting.set(conversationId, timer);
  }
}

// ── Event log helpers ─────────────────────────────────────────────────────────

function addEvent(workspaceId: number, event: string) {
  const ws = getOrCreateState(workspaceId);
  ws.eventLog.unshift({ time: new Date().toISOString(), event });
  if (ws.eventLog.length > MAX_EVENTS) ws.eventLog.pop();
  logger.info({ waEvent: event, workspaceId }, "WhatsApp event");
}

export function getEvents(workspaceId: number): WaEvent[] {
  return [...getOrCreateState(workspaceId).eventLog];
}

// ─── State persistence ────────────────────────────────────────────────────────

/**
 * Load WhatsApp state for all workspaces from DB on server boot.
 * Iterates every workspaceId found in whatsapp_config and auto-reconnects
 * any workspace whose previous session was connected.
 */
export async function loadState(): Promise<void> {
  try {
    const rows = await db.select().from(whatsappConfigTable);
    for (const row of rows) {
      const workspaceId = row.workspaceId;
      const ws = getOrCreateState(workspaceId);
      ws.autoReply = row.autoReply;
      ws.travelMode = row.travelMode;
      try {
        const { aiSettingsTable: s } = await import("@workspace/db");
        const aiRows = await db.select().from(s).limit(1);
        if (aiRows.length > 0) ws.agentMode = (aiRows[0] as any).agentMode ?? "manual";
      } catch (_) { /* keep default */ }
      ws.state = "disconnected";
      ws.qrCode = null;
      ws.client = null;

      if (row.state === "connected") {
        ws.phoneNumber = row.phoneNumber;
        ws.displayName = row.displayName;
      }
      await persistState(workspaceId);

      if (row.state === "connected") {
        addEvent(workspaceId, "Servidor reiniciado — retomando sesión anterior automáticamente…");
        setTimeout(() => connect(workspaceId, false), 2000);
      } else {
        addEvent(workspaceId, "Servidor reiniciado — sesión en espera de reconexión");
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "Could not load WhatsApp state from DB");
  }
}

async function persistState(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  try {
    const rows = await db.select({ id: whatsappConfigTable.id })
      .from(whatsappConfigTable)
      .where(eq(whatsappConfigTable.workspaceId, workspaceId))
      .limit(1);
    const data = {
      state: ws.state,
      phoneNumber: ws.phoneNumber,
      displayName: ws.displayName,
      qrCode: ws.qrCode,
      autoReply: ws.autoReply,
      travelMode: ws.travelMode,
      connectedAt: ws.connectedAt ? new Date(ws.connectedAt) : null,
      updatedAt: new Date(),
    };
    if (rows.length > 0) {
      await db.update(whatsappConfigTable).set(data).where(eq(whatsappConfigTable.id, rows[0].id));
    } else {
      await db.insert(whatsappConfigTable).values({ ...data, workspaceId });
    }
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "Could not persist WhatsApp state");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getStatus(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  return {
    state: ws.state,
    qrCode: ws.qrCode,
    pairingCode: ws.pairingCode,
    phoneNumber: ws.phoneNumber,
    displayName: ws.displayName,
    autoReply: ws.autoReply,
    travelMode: ws.travelMode,
    agentMode: ws.agentMode,
    connectedAt: ws.connectedAt,
    lastError: ws.lastError,
  };
}

export async function getConnectionMonitor(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  const now = Date.now();
  const isConn = ws.state === "connected" || ws.state === "session_restored";
  const currentOfflineDurationMs =
    !isConn && ws.lastDisconnectedAt
      ? now - ws.lastDisconnectedAt.getTime()
      : 0;

  // Lookup last-sent contact name (fast PK-adjacent query, only when we have a phone)
  let lastSentName: string | null = null;
  if (ws.lastSentPhone) {
    try {
      const { clientsTable } = await import("@workspace/db");
      const { like, eq, and } = await import("drizzle-orm");
      const suffix = ws.lastSentPhone.slice(-8);
      const rows = await db
        .select({ name: clientsTable.name })
        .from(clientsTable)
        .where(and(
          eq(clientsTable.workspaceId, workspaceId),
          like(clientsTable.phone, `%${suffix}`),
        ))
        .limit(1);
      if (rows[0]) lastSentName = rows[0].name;
    } catch { /* non-fatal */ }
  }

  return {
    state: ws.state,
    phoneNumber: ws.phoneNumber,
    displayName: ws.displayName,
    lastConnectedAt: ws.lastConnectedAt?.toISOString() ?? null,
    lastDisconnectedAt: ws.lastDisconnectedAt?.toISOString() ?? null,
    lastMessageReceivedAt: ws.lastMessageReceivedAt?.toISOString() ?? null,
    lastSentAt: ws.lastSentAt?.toISOString() ?? null,
    lastSentName,
    disconnectCode: ws.disconnectCode,
    disconnectReason: ws.disconnectReason,
    offlineDurationMs: ws.offlineDurationMs,
    currentOfflineDurationMs,
    connectionLog: ws.connectionLog,
    // Full rich event log (capped at 100 entries, newest first)
    eventLog: ws.eventLog,
  };
}

/**
 * Returns the active Baileys socket for a workspace, or null if not connected.
 * Used exclusively by CustomerSyncService — do NOT use for message sending.
 */
export function getActiveSocket(workspaceId: number): any | null {
  const ws = _workspaceStates.get(workspaceId);
  if (!ws || ws.state !== "connected" || !ws.client) return null;
  return ws.client;
}

function _shouldAutoReply(workspaceId: number): boolean {
  const ws = getOrCreateState(workspaceId);
  const mode = ws.agentMode;
  if (mode === "solidario" || mode === "autonomo") return true;
  if (mode === "noche") {
    const hour = new Date().getHours();
    return hour < 9 || hour >= 18;
  }
  return false;
}

/**
 * Start connection for a workspace. If `clearAuth` is true, wipe the auth
 * directory first so Baileys generates a fresh QR code.
 */
export async function connect(workspaceId: number, clearAuth = false) {
  const ws = getOrCreateState(workspaceId);
  if (ws.isShuttingDown) return getStatus(workspaceId);
  if (!clearAuth && (ws.state === "connected" || ws.state === "connecting")) {
    return getStatus(workspaceId);
  }

  const gotLock = await _acquireOrRenewLock(workspaceId);
  if (!gotLock) {
    addEvent(workspaceId, "Otra instancia sostiene la sesión de WhatsApp — esperando a que quede libre…");
    ws.state = "reconnecting";
    await persistState(workspaceId);
    emit(workspaceId, "status:changed", getStatus(workspaceId));
    setTimeout(() => { if (!ws.isShuttingDown) void connect(workspaceId, clearAuth); }, LOCK_RETRY_MS);
    return getStatus(workspaceId);
  }
  _startLockHeartbeat(workspaceId);

  if (ws.connectingTimer) {
    clearTimeout(ws.connectingTimer);
    ws.connectingTimer = null;
  }

  await _killAuthSocket(workspaceId);

  if (clearAuth) {
    await _closeSocket(workspaceId);
    addEvent(workspaceId, "Generando QR por primera vinculación — eliminando sesión anterior");
    await _clearAllCredentials(workspaceId);
  }

  ws.authMethod = "qr";
  ws.state = "connecting";
  ws.qrCode = null;
  ws.pairingCode = null;
  ws.lastError = null;
  await persistState(workspaceId);
  addEvent(workspaceId, "Iniciando conexión con WhatsApp…");

  const myGen = ++ws.connectGeneration;

  ws.connectingTimer = setTimeout(async () => {
    if (ws.state === "connecting") {
      ws.state = "error";
      ws.lastError = "Tiempo de espera agotado al generar el QR. Intentá de nuevo.";
      await _killAuthSocket(workspaceId);
      await persistState(workspaceId);
      addEvent(workspaceId, "Error: tiempo de espera agotado esperando el QR");
      emit(workspaceId, "status:changed", getStatus(workspaceId));
    }
  }, CONNECTING_TIMEOUT_MS);

  _initQrSocket(workspaceId, myGen).catch(async (e) => {
    logger.error({ err: e, workspaceId }, "QR socket init failed");
    ws.state = "error";
    ws.lastError = `Error al inicializar: ${(e as Error).message}`;
    await persistState(workspaceId);
    addEvent(workspaceId, `Error fatal al inicializar Baileys: ${(e as Error).message}`);
    emit(workspaceId, "status:changed", getStatus(workspaceId));
  });

  return getStatus(workspaceId);
}

/** Soft reconnect: reuse existing credentials — no QR unless session is expired */
export async function reconnect(workspaceId: number) {
  addEvent(workspaceId, "Reconectando — reutilizando sesión existente…");
  return connect(workspaceId, false);
}

/**
 * Cancel an in-progress connection attempt (QR or pairing code) without logging out.
 */
export async function cancelConnection(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  const wasConnecting = (
    ws.state === "connecting" ||
    ws.state === "qr_ready" ||
    ws.state === "reconnecting" ||
    ws.state === "pairing_code_pending"
  );
  addEvent(workspaceId, "Intento de conexión cancelado por el usuario.");
  ws.connectGeneration++;
  debugLog(workspaceId, "cancelConnection called", { wasConnecting, currentState: ws.state, newGen: ws.connectGeneration });

  if (ws.connectingTimer) {
    clearTimeout(ws.connectingTimer);
    ws.connectingTimer = null;
  }

  await _killAuthSocket(workspaceId);

  if (wasConnecting) {
    await _clearAllCredentials(workspaceId);
    ws.state = "disconnected";
    ws.qrCode = null;
    ws.pairingCode = null;
    ws.lastError = null;
    await persistState(workspaceId);
    emit(workspaceId, "status:changed", getStatus(workspaceId));
  }

  return getStatus(workspaceId);
}

/** Manual logout: clears all credentials (local + DB) so the next connect shows a fresh QR */
export async function disconnect(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  addEvent(workspaceId, "Cierre de sesión manual — eliminando credenciales de WhatsApp");
  if (ws.connectingTimer) {
    clearTimeout(ws.connectingTimer);
    ws.connectingTimer = null;
  }
  await _killAuthSocket(workspaceId);
  await _closeSocket(workspaceId);
  await _clearAllCredentials(workspaceId);
  ws.state = "disconnected";
  ws.qrCode = null;
  ws.pairingCode = null;
  ws.phoneNumber = null;
  ws.displayName = null;
  ws.connectedAt = null;
  ws.lastError = null;
  await persistState(workspaceId);
  return getStatus(workspaceId);
}

/**
 * Request a pairing code for phone-number-based device linking.
 */
export async function requestPairingCode(workspaceId: number, phoneNumber: string): Promise<{ code: string } | { error: string }> {
  const ws = getOrCreateState(workspaceId);
  let sanitized = phoneNumber.replace(/\D/g, "");

  logger.info({ phoneRaw: phoneNumber, phoneSanitized: sanitized, workspaceId }, "Pairing code solicitado por usuario");
  addEvent(workspaceId, `Código solicitado — número recibido: "${phoneNumber}" → sanitizado: "${sanitized}"`);

  if (!sanitized) return { error: "Ingresá tu número de teléfono." };
  if (sanitized.length < 10) {
    return { error: `Número demasiado corto (${sanitized.length} dígitos). Incluí el código de país sin '+'. Ejemplo Argentina: 5491112345678` };
  }
  if (sanitized.length > 15) {
    return { error: `Número demasiado largo (${sanitized.length} dígitos). Verificá que no haya dígitos extra.` };
  }

  if (sanitized.startsWith("54") && !sanitized.startsWith("549") && sanitized.length === 12) {
    const corrected = "549" + sanitized.slice(2);
    addEvent(workspaceId, `Auto-corrección Argentina: ${sanitized} → ${corrected} (se insertó el '9' de celular)`);
    logger.info({ original: sanitized, corrected }, "Argentina mobile number auto-corrected: inserted '9' prefix");
    sanitized = corrected;
  }

  if (ws.state === "connected" || ws.state === "session_restored") {
    return { error: "Ya hay una sesión activa. Cerrá la sesión actual antes de vincular un nuevo dispositivo." };
  }

  await _killAuthSocket(workspaceId);
  await _closeSocket(workspaceId);
  await _clearAllCredentials(workspaceId);
  ws.authMethod = "pairing";
  ws.pairingCode = null;
  ws.qrCode = null;
  ws.state = "connecting";
  ws.lastError = null;
  await persistState(workspaceId);
  emit(workspaceId, "status:changed", getStatus(workspaceId));

  const myGen = ++ws.connectGeneration;

  const code = await _initPairingSocket(workspaceId, sanitized, myGen);

  if (code) {
    logger.info({ phoneSanitized: sanitized, code, workspaceId }, "Pairing code delivered to frontend");
    addEvent(workspaceId, `Resultado código: OK — ${code}`);
    return { code };
  } else {
    const errMsg = ws.lastError ?? "Error al solicitar código. Intentá de nuevo.";
    logger.error({ phoneSanitized: sanitized, errMsg, workspaceId }, "Pairing code request failed");
    addEvent(workspaceId, `Resultado código: ERROR — ${errMsg}`);
    return { error: errMsg };
  }
}

export async function sendMessage(
  workspaceId: number,
  conversationId: number,
  content: string,
): Promise<{ id: number; status: string }> {
  const ws = getOrCreateState(workspaceId);
  cancelPendingAutoReply(workspaceId, conversationId);
  cancelWaiting(workspaceId, conversationId);
  const conv = await db.query.conversationsTable.findFirst({
    where: and(eq(conversationsTable.id, conversationId), eq(conversationsTable.workspaceId, workspaceId)),
  });

  const isConnected = ws.state === "connected" && !!ws.client && !!conv?.whatsappJid;

  const [msg] = await db.insert(messagesTable).values({
    workspaceId,
    conversationId,
    content,
    direction: "outbound",
    sentAt: new Date(),
    isRead: true,
    aiGenerated: false,
    status: isConnected ? "sending" : "pending",
  }).returning({ id: messagesTable.id, status: messagesTable.status });

  if (conv?.clientId) {
    logClientEvent({
      workspaceId, clientId: conv.clientId, type: "message_sent", detail: content.substring(0, 160),
      actor: "Operador", relatedType: "message", relatedId: msg.id,
    });
  }

  emit(workspaceId, "message:new", {
    conversationId,
    contactName: conv?.contactName ?? "",
    preview: content.substring(0, 80),
    direction: "outbound",
    messageId: msg.id,
    status: msg.status,
  });

  await db.update(conversationsTable)
    .set({ lastMessage: content, lastMessageAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));
  await scheduleUnanswered(workspaceId, conversationId);
  maybeMarkResolved(workspaceId, conversationId, content).catch(() => {});

  if (isConnected) {
    try {
      const waResult = await (ws.client as any).sendMessage(conv!.whatsappJid!, { text: content });
      const waId: string | null = waResult?.key?.id ?? null;
      await db.update(messagesTable)
        .set({ status: "sent", whatsappId: waId })
        .where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "sent" });
    } catch (e) {
      logger.error({ err: e, workspaceId }, "Failed to send WhatsApp message");
      await db.update(messagesTable).set({ status: "failed" }).where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "failed" });
    }
  }

  return { id: msg.id, status: isConnected ? "sent" : "pending" };
}

// ─── Send a reaction to a message (emoji reaction, WhatsApp-style) ───────────
// Emoji = ""  → removes the previous reaction.
export async function sendReaction(
  workspaceId: number,
  messageId: number,
  emoji: string,
): Promise<void> {
  const ws = getOrCreateState(workspaceId);

  const [row] = await db
    .select({
      whatsappId: messagesTable.whatsappId,
      direction:  messagesTable.direction,
      jid:        conversationsTable.whatsappJid,
    })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(conversationsTable.id, messagesTable.conversationId))
    .where(and(eq(messagesTable.id, messageId), eq(conversationsTable.workspaceId, workspaceId)))
    .limit(1);

  if (!row) throw new Error("Mensaje no encontrado");

  // Upsert reaction locally (emoji="" means reaction removed)
  await db.insert(messageReactionsTable).values({
    workspaceId,
    messageId,
    emoji,
    senderJid: "me",
    fromMe: true,
    reactedAt: new Date(),
  }).onConflictDoUpdate({
    target: [messageReactionsTable.messageId, messageReactionsTable.senderJid],
    set: { emoji, reactedAt: new Date() },
  });

  // Forward to WhatsApp if we have an active connection and a WA message ID
  if (ws.state === "connected" && ws.client && row.jid && row.whatsappId) {
    await (ws.client as any).sendMessage(row.jid, {
      react: {
        text: emoji,                          // "" = remove reaction
        key: {
          id: row.whatsappId,
          remoteJid: row.jid,
          fromMe: row.direction === "outbound",
        },
      },
    });
  }
}

// Builds the phone string for outbound WA JIDs (e.g. "549..." → "549...@s.whatsapp.net").
// NOTE: this intentionally does NOT apply the 54+12-digit → 549 correction that
// normalizePhone() does, because WhatsApp itself resolves Argentine numbers and adding
// the 9 on outbound JIDs has caused delivery failures. Any change here must be tested
// against outbound message delivery, not just DB storage.
// For DB storage and client lookup, always use normalizePhone() from lib/phone.ts.
function normalizePhoneForWA(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return digits;
  return digits.length <= 10 ? `549${digits}` : digits;
}

// Alias kept for clarity — inbound JID digits go through the canonical normalizePhone().
// This ensures inbound phones in the DB always match how client phones are stored.
function normalizeInboundPhone(rawPhone: string): string {
  return normalizePhone(rawPhone);
}

export async function startConversation(
  workspaceId: number,
  rawPhone: string,
  contactName: string,
  content: string,
  clientId?: number | null,
): Promise<{ conversationId: number; messageId: number; status: string }> {
  const ws = getOrCreateState(workspaceId);
  const phone = normalizePhoneForWA(rawPhone);
  if (!phone) throw new Error("Número de teléfono inválido");

  const jid = `${phone}@s.whatsapp.net`;
  const isConnected = ws.state === "connected" && !!ws.client;

  const upsertValues: Partial<typeof conversationsTable.$inferInsert> & {
    workspaceId: number; contactName: string; contactPhone: string; status: string;
    lastMessage: string; lastMessageAt: Date; whatsappJid: string;
  } = {
    workspaceId,
    contactName: contactName.trim() || phone,
    contactPhone: phone,
    whatsappJid: jid,
    status: "unanswered",
    lastMessage: content.trim().substring(0, 120),
    lastMessageAt: new Date(),
    ...(clientId ? { clientId } : {}),
  };

  const [conv] = await db
    .insert(conversationsTable)
    .values(upsertValues)
    .onConflictDoUpdate({
      // Unique constraint is (workspace_id, contact_phone) — must list both columns.
      target: [conversationsTable.workspaceId, conversationsTable.contactPhone],
      set: {
        contactName: upsertValues.contactName,
        whatsappJid: jid,
        lastMessage: upsertValues.lastMessage,
        lastMessageAt: upsertValues.lastMessageAt,
        ...(clientId ? { clientId } : {}),
      },
    })
    .returning();

  const conversationId = conv.id;

  cancelWaiting(workspaceId, conversationId);

  const [msg] = await db.insert(messagesTable).values({
    workspaceId,
    conversationId,
    content,
    direction: "outbound",
    sentAt: new Date(),
    isRead: true,
    aiGenerated: false,
    status: isConnected ? "sending" : "pending",
  }).returning({ id: messagesTable.id, status: messagesTable.status });

  emit(workspaceId, "message:new", {
    conversationId,
    contactName: conv.contactName,
    preview: content.substring(0, 80),
    direction: "outbound",
    messageId: msg.id,
    status: msg.status,
  });

  scheduleUnanswered(workspaceId, conversationId).catch(e =>
    logger.warn({ err: e, conversationId, workspaceId }, "scheduleUnanswered failed in startConversation"),
  );

  let finalStatus = isConnected ? "sent" : "pending";

  if (isConnected) {
    try {
      const waResult = await (ws.client as any).sendMessage(jid, { text: content });
      const waId: string | null = waResult?.key?.id ?? null;
      await db.update(messagesTable)
        .set({ status: "sent", whatsappId: waId })
        .where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "sent" });
    } catch (e) {
      logger.error({ err: e, workspaceId }, "Failed to send first WhatsApp message");
      await db.update(messagesTable).set({ status: "failed" }).where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "failed" });
      finalStatus = "failed";
    }
  }

  // Fire-and-forget: fetch WA profile photo so the avatar is visible immediately
  // when the user opens the newly created conversation.
  if (ws.client) {
    const _sock = ws.client;
    const _convId = conversationId;
    const _clientId = clientId ?? null;
    (async () => {
      try {
        const photoUrl: string | undefined = await (_sock as any).profilePictureUrl(jid, "image");
        if (photoUrl) {
          await db.update(conversationsTable)
            .set({ contactAvatar: photoUrl })
            .where(and(eq(conversationsTable.id, _convId), eq(conversationsTable.workspaceId, workspaceId)));
          if (_clientId) {
            await db.update(clientsTable)
              .set({ profilePicUrl: photoUrl })
              .where(and(eq(clientsTable.id, _clientId), eq(clientsTable.workspaceId, workspaceId)));
          }
        }
      } catch { /* private / not on WA / offline — silently skip */ }
    })();
  }

  return { conversationId, messageId: msg.id, status: finalStatus };
}


async function _flushPendingMessages(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  if (ws.flushing) return;
  ws.flushing = true;
  try {
    const { and, sql: drizzleSql } = await import("drizzle-orm");

    const claimed = await db
      .update(messagesTable)
      .set({ status: "sending" })
      .where(and(
        eq(messagesTable.direction, "outbound"),
        eq(messagesTable.status, "pending"),
      ))
      .returning({
        id: messagesTable.id,
        conversationId: messagesTable.conversationId,
        content: messagesTable.content,
      });

    if (!claimed.length) return;
    addEvent(workspaceId, `Enviando ${claimed.length} mensaje(s) pendiente(s)…`);

    for (const msg of claimed) {
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId: msg.conversationId, status: "sending" });

      const conv = await db.query.conversationsTable.findFirst({
        where: and(eq(conversationsTable.id, msg.conversationId), eq(conversationsTable.workspaceId, workspaceId)),
      });

      if (!conv?.whatsappJid) {
        logger.warn({ msgId: msg.id, workspaceId }, "Pending message has no whatsappJid — skipping (not failing)");
        await db.update(messagesTable).set({ status: "pending" }).where(eq(messagesTable.id, msg.id));
        emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId: msg.conversationId, status: "pending" });
        continue;
      }

      if (!ws.client || ws.state !== "connected") {
        await db.update(messagesTable).set({ status: "pending" }).where(eq(messagesTable.id, msg.id));
        emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId: msg.conversationId, status: "pending" });
        break;
      }

      try {
        const waResult = await (ws.client as any).sendMessage(conv.whatsappJid, { text: msg.content });
        const waId: string | null = waResult?.key?.id ?? null;
        await db.update(messagesTable).set({ status: "sent", whatsappId: waId }).where(eq(messagesTable.id, msg.id));
        emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId: msg.conversationId, status: "sent" });
      } catch (e) {
        logger.error({ err: e, msgId: msg.id, workspaceId }, "Failed to flush pending message");
        await db.update(messagesTable).set({ status: "failed" }).where(eq(messagesTable.id, msg.id));
        emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId: msg.conversationId, status: "failed" });
      }
    }
    addEvent(workspaceId, "Mensajes pendientes procesados");
  } catch (e) {
    logger.error({ err: e, workspaceId }, "Error flushing pending messages");
  } finally {
    ws.flushing = false;
  }
}

export async function updateAutoReply(workspaceId: number, autoReply?: boolean, travelMode?: boolean, agentMode?: string) {
  const ws = getOrCreateState(workspaceId);
  if (autoReply !== undefined) ws.autoReply = autoReply;
  if (travelMode !== undefined) ws.travelMode = travelMode;
  if (agentMode !== undefined) ws.agentMode = agentMode;
  await persistState(workspaceId);
  return getStatus(workspaceId);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _killAuthSocket(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  if (ws.authSocket) {
    const dyingSocket = ws.authSocket;
    ws.authSocket = null;
    ws.authMethod = null;
    try { (dyingSocket as any).end(new Error("Manual close")); } catch (_) {}
    try { (dyingSocket as any).ws?.close?.(); } catch (_) {}
  }
}

async function _closeSocket(workspaceId: number) {
  const ws = getOrCreateState(workspaceId);
  if (ws.client) {
    const dyingSocket = ws.client;
    ws.client = null;
    try { (dyingSocket as any).end(new Error("Manual close")); } catch (_) {}
    try { (dyingSocket as any).ws?.close?.(); } catch (_) {}
  }
}

// Cached across the process lifetime — avoids repeating an external network
// call (to WhatsApp's own version-check endpoint) on every single connect/
// reconnect attempt. Falls back to whatever Baileys ships as its own
// internal default if the lookup is slow/unreachable, instead of letting a
// hung network call stall the whole connection attempt (and, transitively,
// the event loop) for other concurrent requests.
let _cachedBaileysVersion: { version: any } | null = null;

async function _getBaileysVersion(
  fetchLatestBaileysVersion: () => Promise<{ version: any }>,
): Promise<{ version: any } | undefined> {
  if (_cachedBaileysVersion) return _cachedBaileysVersion;
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fetchLatestBaileysVersion timeout")), 5_000),
      ),
    ]);
    _cachedBaileysVersion = result;
    return result;
  } catch (err) {
    logger.warn({ err }, "fetchLatestBaileysVersion failed/timed out — using Baileys' built-in default version");
    return undefined;
  }
}

// ─── Socket creation & authentication ────────────────────────────────────────

async function _makeWASocket(workspaceId: number) {
  const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } =
    await import("@whiskeysockets/baileys") as any;

  const versionResult = await _getBaileysVersion(fetchLatestBaileysVersion);
  const version = versionResult?.version;
  if (version) {
    addEvent(workspaceId, `Usando Baileys v${version.join(".")}`);
  } else {
    addEvent(workspaceId, "No se pudo verificar la última versión de Baileys — usando la versión por defecto");
  }

  const authDir = getAuthDir(workspaceId);
  await mkdir(authDir, { recursive: true });

  const restoredFromDb = await _restoreCredsFromDb(workspaceId);
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const hasExistingCreds = !!authState.creds?.registered;

  if (restoredFromDb && hasExistingCreds) {
    addEvent(workspaceId, "Sesión encontrada — intentando reanudar sin necesidad de QR…");
  } else if (hasExistingCreds) {
    addEvent(workspaceId, "Credenciales locales encontradas — intentando reanudar sesión");
  } else {
    addEvent(workspaceId, "Sin credenciales previas — generando QR por primera vinculación");
  }

  debugLog(workspaceId, "Socket creado", {
    version: version.join("."),
    hasExistingCreds,
    restoredFromDb,
    registered: authState.creds?.registered ?? false,
    hasCresMe: !!authState.creds?.me,
  });

  const saveCredsAndBackup = async () => {
    await saveCreds();
    await _backupCredsToDB(workspaceId);
    const registered = authState.creds?.registered ?? false;
    debugLog(workspaceId, "Credenciales guardadas", { registered, hasPairingCode: !!authState.creds?.pairingCode });
    addEvent(workspaceId, "Sesión persistida correctamente");
  };

  const sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    browser: ["CharlyWhatsapp", "Chrome", "3.0.0"],
    connectTimeoutMs: 30_000,
    retryRequestDelayMs: 2000,
    logger: {
      level: "silent",
      trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
      child: () => ({ level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }),
    },
  });

  debugLog(workspaceId, "makeWASocket() retornó — WS conectando…", {
    wsReadyState: (sock as any).ws?.readyState ?? "desconocido",
  });

  return { sock, saveCredsAndBackup };
}

async function _onConnectionOpen(workspaceId: number, sock: any, isNewLogin: boolean) {
  const ws = getOrCreateState(workspaceId);
  logger.info({ workspaceId, isNewLogin, user: sock.user?.id ?? null }, "[AUDIT] connection.update open — socket abierto");
  if (ws.connectingTimer) {
    clearTimeout(ws.connectingTimer);
    ws.connectingTimer = null;
  }
  ws.qrCode = null;
  ws.pairingCode = null;
  ws.lastError = null;
  ws.phoneNumber = sock.user?.id?.split(":")[0] ?? null;
  ws.displayName = sock.user?.name ?? null;
  ws.connectedAt = new Date().toISOString();

  // Connection monitor
  const now = new Date();
  if (ws.lastDisconnectedAt) {
    ws.offlineDurationMs += now.getTime() - ws.lastDisconnectedAt.getTime();
  }
  ws.lastConnectedAt = now;
  ws.lastDisconnectedAt = null;
  const logEntry: (typeof ws.connectionLog)[0] = {
    type: "connected",
    at: now.toISOString(),
    offlineDurationMs: ws.lastConnectedAt ? undefined : 0,
  };
  ws.connectionLog.push(logEntry);
  if (ws.connectionLog.length > 50) ws.connectionLog.shift();

  if (isNewLogin) {
    ws.state = "connected";
    logger.info({ workspaceId, state: "connected", isNewLogin: true }, "[AUDIT] estado → connected (nueva vinculación)");
    await persistState(workspaceId);
    addEvent(workspaceId, `Conectado exitosamente — nueva vinculación: ${ws.displayName ?? ws.phoneNumber}`);
    await _logActivity(workspaceId, "message_received", `WhatsApp vinculado: ${ws.displayName ?? ws.phoneNumber}`, null);
  } else {
    ws.state = "session_restored";
    logger.info({ workspaceId, state: "session_restored", isNewLogin: false }, "[AUDIT] estado → session_restored (reconexión)");
    await persistState(workspaceId);
    addEvent(workspaceId, `Sesión restaurada — ${ws.displayName ?? ws.phoneNumber}`);
    await _logActivity(workspaceId, "message_received", `WhatsApp reconectado: ${ws.displayName ?? ws.phoneNumber}`, null);
    emit(workspaceId, "status:changed", getStatus(workspaceId));
    setTimeout(async () => {
      if (ws.state === "session_restored") {
        ws.state = "connected";
        logger.info({ workspaceId, state: "connected" }, "[AUDIT] estado → connected (session_restored → connected tras 4s)");
        await persistState(workspaceId);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
        logger.info({ workspaceId }, "[AUDIT] frontend notificado: status:changed (connected tras restauración)");
      }
    }, 4000);
  }

  logger.info({ workspaceId, state: ws.state }, "[AUDIT] frontend notificado: status:changed");
  emit(workspaceId, "status:changed", getStatus(workspaceId));
  setTimeout(() => _flushPendingMessages(workspaceId), 1500);
}

// ── QR authentication flow ────────────────────────────────────────────────────

async function _initQrSocket(workspaceId: number, expectedGen: number) {
  const { sock, saveCredsAndBackup } = await _makeWASocket(workspaceId);
  const ws = getOrCreateState(workspaceId);

  if (ws.connectGeneration !== expectedGen) {
    debugLog(workspaceId, "_initQrSocket: stale attempt discarded", { expectedGen, currentGen: ws.connectGeneration });
    try { (sock as any).end(new Error("Stale connection attempt — cancelled")); } catch (_) {}
    return;
  }

  ws.authSocket = sock;

  _wireSessionHandlers(workspaceId, sock, saveCredsAndBackup);

  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (sock !== ws.authSocket && sock !== ws.client) return;

    if (qr && sock === ws.authSocket) {
      if (ws.connectingTimer) { clearTimeout(ws.connectingTimer); ws.connectingTimer = null; }
      logger.info({ workspaceId }, "[AUDIT] QR generado — esperando escaneo del usuario");
      try {
        const QRCode = await import("qrcode") as any;
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        ws.qrCode = qrDataUrl;
        ws.state = "qr_ready";
        await persistState(workspaceId);
        addEvent(workspaceId, "QR generado — esperando escaneo del usuario");
        emit(workspaceId, "status:changed", getStatus(workspaceId));
      } catch (e) {
        ws.state = "error";
        ws.lastError = "No se pudo generar la imagen QR";
        await persistState(workspaceId);
        addEvent(workspaceId, "Error al generar imagen QR");
        emit(workspaceId, "status:changed", getStatus(workspaceId));
      }
    }

    if (connection === "open") {
      logger.info({ workspaceId, isNewLogin: !!isNewLogin }, "[AUDIT] QR escaneado — connection.update open recibido");
      if (sock === ws.authSocket) { ws.authSocket = null; ws.authMethod = null; }
      ws.client = sock;
      await _onConnectionOpen(workspaceId, sock, isNewLogin);
    }

    if (connection === "close") {
      if (sock !== ws.authSocket && sock !== ws.client) return;
      if (ws.connectingTimer) { clearTimeout(ws.connectingTimer); ws.connectingTimer = null; }

      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isAuthFail = statusCode === 401 || statusCode === 403;
      const errorMsg = (lastDisconnect?.error as Error)?.message || "Conexión cerrada";

      logger.info({ workspaceId, statusCode: statusCode ?? null, errorMsg }, "[AUDIT] socket cerrado — motivo de cierre recibido");
      addEvent(workspaceId, `Conexión cerrada — código: ${statusCode ?? "desconocido"} — ${errorMsg}`);

      // Connection monitor
      const disconnectedAt = new Date();
      ws.lastDisconnectedAt = disconnectedAt;
      ws.disconnectCode = statusCode ?? null;
      ws.disconnectReason = errorMsg;
      ws.connectionLog.push({ type: "disconnected", at: disconnectedAt.toISOString() });
      if (ws.connectionLog.length > 50) ws.connectionLog.shift();

      if (sock === ws.authSocket) { ws.authSocket = null; ws.authMethod = null; }
      if (sock === ws.client) { ws.client = null; }

      if (isAuthFail) {
        await _clearAllCredentials(workspaceId);
        ws.state = "session_invalid";
        ws.qrCode = null;
        ws.pairingCode = null;
        ws.phoneNumber = null;
        ws.displayName = null;
        ws.connectedAt = null;
        ws.lastError = "Sesión inválida. Pulsá 'Conectar' para vincular el dispositivo nuevamente.";
        addEvent(workspaceId, "Sesión inválida — WhatsApp cerró la sesión. Pulsá Conectar para generar un nuevo QR.");
        await persistState(workspaceId);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
      } else if (ws.isShuttingDown) {
        ws.state = "disconnected";
        ws.qrCode = null;
        ws.pairingCode = null;
        addEvent(workspaceId, "Desconexión durante apagado — no se reintenta (nueva instancia tomará la sesión).");
        await persistState(workspaceId);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
      } else {
        const delayMs = _reconnectDelayMs(workspaceId, statusCode);
        ws.state = "reconnecting";
        ws.qrCode = null;
        ws.pairingCode = null;
        ws.lastError = null;
        addEvent(workspaceId, `Desconexión transitoria — reconectando en ${Math.round(delayMs / 1000)} segundos…`);
        await persistState(workspaceId);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
        setTimeout(() => { if (ws.state === "reconnecting" && !ws.isShuttingDown) connect(workspaceId, false); }, delayMs);
      }
    }
  });
}

// ── Pairing code authentication flow ─────────────────────────────────────────

async function _initPairingSocket(workspaceId: number, phone: string, expectedGen: number): Promise<string | null> {
  const { sock, saveCredsAndBackup } = await _makeWASocket(workspaceId);
  const ws = getOrCreateState(workspaceId);

  if (ws.connectGeneration !== expectedGen) {
    debugLog(workspaceId, "_initPairingSocket: stale attempt discarded", { expectedGen, currentGen: ws.connectGeneration });
    try { (sock as any).end(new Error("Stale pairing attempt — cancelled")); } catch (_) {}
    return null;
  }

  ws.authSocket = sock;

  _wireSessionHandlers(workspaceId, sock, saveCredsAndBackup);

  return new Promise<string | null>((resolve) => {
    let pairingCodeRequested = false;
    let settled = false;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    const timeoutHandle = setTimeout(async () => {
      if (!settled) {
        logger.warn({ phone, workspaceId }, "_initPairingSocket timed out — settling null");
        addEvent(workspaceId, "Tiempo de espera agotado al generar el código. Intentá de nuevo.");
        ws.state = "error";
        ws.lastError = "Tiempo de espera agotado al generar el código.";
        await persistState(workspaceId);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
        settle(null);
      }
    }, 60_000);

    const doRequestPairingCode = async () => {
      if (pairingCodeRequested) return;
      pairingCodeRequested = true;

      const tStart = Date.now();
      debugLog(workspaceId, "Pairing solicitado — llamando requestPairingCode()", {
        phone,
        wsReadyState: (sock as any).ws?.readyState ?? "desconocido",
        socketAlive: !!(sock as any).ws?.isOpen,
        authRegistered: !!(sock as any).authState?.creds?.registered,
        t: new Date().toISOString(),
      });

      try {
        addEvent(workspaceId, `Solicitando código a WhatsApp — número: ${phone}`);
        logger.info({ phone, workspaceId }, "WS open (pair-device received) — calling requestPairingCode");
        const code: string = await (sock as any).requestPairingCode(phone);
        const elapsedMs = Date.now() - tStart;

        logger.info({ phone, code, workspaceId }, "Pairing code received from Baileys");
        ws.pairingCode = code;

        debugLog(workspaceId, "Pairing recibido", {
          phone,
          code,
          codeHex: Buffer.from(code, "utf8").toString("hex"),
          elapsedMs,
          wsReadyState: (sock as any).ws?.readyState ?? "desconocido",
          t: new Date().toISOString(),
        });

        addEvent(workspaceId, `✓ Código generado: ${code} — ingresalo en WhatsApp → Configuración → Dispositivos vinculados → Vincular con número de teléfono`);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
        settle(code);
      } catch (e: any) {
        const errMsg = (e as Error)?.message ?? String(e);
        logger.error({ err: e, phone, errMsg, workspaceId }, "requestPairingCode failed");
        addEvent(workspaceId, `Error al solicitar código de vinculación: ${errMsg}`);

        if (sock === ws.authSocket) { ws.authSocket = null; ws.authMethod = null; }
        try { (sock as any).end(new Error("Pairing code request failed")); } catch (_) {}

        ws.state = "error";
        ws.lastError = errMsg;
        await persistState(workspaceId);
        emit(workspaceId, "status:changed", getStatus(workspaceId));
        settle(null);
      }
    };

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, isNewLogin, qr } = update;

      const isActiveAuth = sock === ws.authSocket;

      debugLog(workspaceId, "Connection Update recibido", {
        connection: connection ?? "–",
        hasQr: !!qr,
        isNewLogin: !!isNewLogin,
        isActiveAuth,
        wsReadyState: (sock as any).ws?.readyState ?? "desconocido",
        statusCode: (lastDisconnect?.error as any)?.output?.statusCode ?? "–",
        errorMsg: (lastDisconnect?.error as any)?.message ?? "–",
        t: new Date().toISOString(),
      });

      if (qr && isActiveAuth) {
        await doRequestPairingCode();
        return;
      }

      if (connection === "open") {
        if (isActiveAuth) { ws.authSocket = null; ws.authMethod = null; }
        ws.client = sock;
        await _onConnectionOpen(workspaceId, sock, isNewLogin);
        settle(ws.pairingCode);
      }

      if (connection === "close") {
        if (ws.connectingTimer) { clearTimeout(ws.connectingTimer); ws.connectingTimer = null; }

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isAuthFail = statusCode === 401 || statusCode === 403;
        const errorMsg = (lastDisconnect?.error as Error)?.message || "Conexión cerrada";

        const wasSession = sock === ws.client;

        if (sock === ws.authSocket) { ws.authSocket = null; ws.authMethod = null; }
        if (sock === ws.client) { ws.client = null; }

        if (!isActiveAuth && !wasSession) {
          addEvent(workspaceId, "Conexión de vinculación cancelada externamente.");
          settle(null);
          return;
        }

        addEvent(workspaceId, `Conexión cerrada — código: ${statusCode ?? "desconocido"} — ${errorMsg}`);

        if (wasSession && !isAuthFail && ws.isShuttingDown) {
          ws.state = "disconnected";
          ws.qrCode = null;
          ws.pairingCode = null;
          addEvent(workspaceId, "Desconexión durante apagado — no se reintenta (nueva instancia tomará la sesión).");
          await persistState(workspaceId);
          emit(workspaceId, "status:changed", getStatus(workspaceId));
          settle(null);
        } else if (wasSession && !isAuthFail) {
          const delayMs = _reconnectDelayMs(workspaceId, statusCode);
          ws.state = "reconnecting";
          ws.qrCode = null;
          ws.pairingCode = null;
          ws.lastError = null;
          addEvent(workspaceId, `Desconexión transitoria — reconectando en ${Math.round(delayMs / 1000)} segundos…`);
          await persistState(workspaceId);
          emit(workspaceId, "status:changed", getStatus(workspaceId));
          setTimeout(() => { if (ws.state === "reconnecting" && !ws.isShuttingDown) connect(workspaceId, false); }, delayMs);
          settle(null);
        } else if (wasSession && isAuthFail) {
          await _clearAllCredentials(workspaceId);
          ws.state = "session_invalid";
          ws.qrCode = null;
          ws.pairingCode = null;
          ws.phoneNumber = null;
          ws.displayName = null;
          ws.connectedAt = null;
          ws.lastError = "Sesión inválida. Pulsá 'Conectar' para vincular el dispositivo nuevamente.";
          addEvent(workspaceId, "Sesión inválida — WhatsApp cerró la sesión.");
          await persistState(workspaceId);
          emit(workspaceId, "status:changed", getStatus(workspaceId));
          settle(null);
        } else if (isAuthFail) {
          await _clearAllCredentials(workspaceId);
          ws.state = "error";
          ws.qrCode = null;
          ws.pairingCode = null;
          ws.lastError = `Error de vinculación (${statusCode}). Verificá tu número e intentá de nuevo.`;
          addEvent(workspaceId, "Error de vinculación — WhatsApp rechazó la solicitud. Verificá tu número e intentá de nuevo.");
          await persistState(workspaceId);
          emit(workspaceId, "status:changed", getStatus(workspaceId));
          settle(null);
        } else if (ws.pairingCode) {
          const preservedCode = ws.pairingCode;
          ws.state = "pairing_code_pending";
          ws.pairingCode = preservedCode;
          ws.lastError = null;
          addEvent(workspaceId, "Código listo — ingresalo en WhatsApp → Configuración → Dispositivos vinculados → Vincular con número de teléfono");
          await persistState(workspaceId);
          emit(workspaceId, "status:changed", getStatus(workspaceId));
          settle(preservedCode);
        } else {
          ws.state = "error";
          ws.lastError = `Error de conexión: ${errorMsg}. Intentá de nuevo.`;
          addEvent(workspaceId, `Error al vincular — ${errorMsg}`);
          await persistState(workspaceId);
          emit(workspaceId, "status:changed", getStatus(workspaceId));
          settle(null);
        }
      }
    });
  });
}

// ── Shared session + message handlers ─────────────────────────────────────────

function _wireSessionHandlers(workspaceId: number, sock: any, saveCredsAndBackup: () => Promise<void>) {
  const ws = getOrCreateState(workspaceId);
  let _lastRegistered = false;
  sock.ev.on("creds.update", async () => {
    const registered = !!(sock as any).authState?.creds?.registered;
    logger.info({ workspaceId, registered }, "[AUDIT] creds.update — credenciales recibidas y guardadas");
    await saveCredsAndBackup();
    const nowRegistered = !!(sock as any).authState?.creds?.registered;
    if (nowRegistered && !_lastRegistered) {
      _lastRegistered = true;
      logger.info({ workspaceId }, "[AUDIT] creds.update — registered=true (companion_finish completado)");
      debugLog(workspaceId, "Credenciales cargadas — Etapa 2 (companion_finish) completada", {
        registered: true,
        hasPairingCode: !!ws.pairingCode,
        t: new Date().toISOString(),
      });
      if (DEBUG_WA) addEvent(workspaceId, "[DEBUG] Etapa 2 completada: companion_finish enviado, esperando pair-success de WhatsApp");
    }
  });

  sock.ev.on("contacts.set",    ({ contacts }: any) => _indexContacts(workspaceId, contacts ?? []));
  sock.ev.on("contacts.upsert", (contacts: any[])   => _indexContacts(workspaceId, contacts ?? []));
  sock.ev.on("contacts.update", (updates: any[])    => _indexContacts(workspaceId, updates  ?? []));

  sock.ev.on("messaging-history.set", async ({ chats, messages, contacts, syncType, isLatest }: any) => {
    const chatCount = (chats ?? []).length;
    const msgCount  = (messages ?? []).length;
    logger.info({ chatCount, msgCount, syncType, isLatest, workspaceId }, "History sync received from WhatsApp");
    addEvent(workspaceId, `Sincronización WA recibida: ${chatCount} chats, ${msgCount} mensajes`);

    if ((contacts ?? []).length) _indexContacts(workspaceId, contacts);

    let chatsCreated  = 0;
    let chatsSkipped  = 0;
    let msgsImported  = 0;
    let msgsDuplicate = 0;
    let errors        = 0;

    for (const chat of (chats ?? [])) {
      try {
        const rawJid: string = chat.id ?? "";
        if (!rawJid || rawJid.endsWith("@g.us") || rawJid.endsWith("@broadcast") || rawJid === "status@broadcast") {
          chatsSkipped++;
          continue;
        }
        let resolvedJid = rawJid;
        if (rawJid.endsWith("@lid")) {
          const mapped = ws.lidToJid.get(rawJid) ?? await _resolveLidViaSignalStore(sock, rawJid);
          if (!mapped) { chatsSkipped++; continue; }
          resolvedJid = mapped;
          ws.lidToJid.set(rawJid, resolvedJid);
        }

        const phone = normalizeInboundPhone(resolvedJid.replace(/@.*/, ""));
        if (!phone) { chatsSkipped++; continue; }

        const contactName = (chat.name || chat.verifiedName || chat.notify || phone) as string;
        const tsRaw = chat.conversationTimestamp;
        const lastMsgAt = tsRaw
          ? new Date((typeof tsRaw === "number" ? tsRaw : (tsRaw as any).toNumber?.() ?? 0) * 1000)
          : new Date();

        const existing = await db.query.conversationsTable.findFirst({
          where: and(eq(conversationsTable.contactPhone, phone), eq(conversationsTable.workspaceId, workspaceId)),
        });

        if (!existing) {
          try {
            await db.insert(conversationsTable).values({
              workspaceId,
              contactName,
              contactPhone: phone,
              lastMessage: "",
              lastMessageAt: lastMsgAt,
              unreadCount: 0,
              whatsappJid: resolvedJid,
              status: "active",
            });
            chatsCreated++;
          } catch (ie: any) {
            if (ie?.code === "23505") { chatsSkipped++; }
            else throw ie;
          }
        } else {
          if (!existing.whatsappJid || (existing.whatsappJid !== resolvedJid && resolvedJid.endsWith("@s.whatsapp.net"))) {
            await db.update(conversationsTable)
              .set({ whatsappJid: resolvedJid })
              .where(eq(conversationsTable.id, existing.id));
          }
          chatsSkipped++;
        }
      } catch (e) {
        logger.warn({ err: e, chatId: chat.id, workspaceId }, "Error importing chat from history");
        errors++;
      }
    }

    const convCache = new Map<string, { id: number; lastMessageAt: Date }>();

    for (const msg of (messages ?? [])) {
      try {
        const rawJid: string = msg.key?.remoteJid ?? "";
        if (!rawJid || rawJid.endsWith("@g.us") || rawJid === "status@broadcast" || rawJid.endsWith("@broadcast")) continue;

        const waId: string | null = msg.key?.id ?? null;
        if (!waId) continue;

        let resolvedJid = rawJid;
        if (rawJid.endsWith("@lid")) {
          const mapped = ws.lidToJid.get(rawJid) ?? await _resolveLidViaSignalStore(sock, rawJid);
          if (!mapped) continue;
          resolvedJid = mapped;
          ws.lidToJid.set(rawJid, resolvedJid);
        }
        const phone = normalizeInboundPhone(resolvedJid.replace(/@.*/, ""));
        if (!phone) continue;

        if (!convCache.has(phone)) {
          let c = await db.query.conversationsTable.findFirst({
            where: and(eq(conversationsTable.contactPhone, phone), eq(conversationsTable.workspaceId, workspaceId)),
          });
          if (!c) {
            try {
              const [created] = await db.insert(conversationsTable).values({
                workspaceId,
                contactName: msg.pushName || phone,
                contactPhone: phone,
                // Use a placeholder — will be overwritten by the message loop update below
                lastMessage: "",
                lastMessageAt: new Date(0),   // epoch 0 so every real message beats it
                unreadCount: 0,
                whatsappJid: resolvedJid,
                status: "active",
              }).returning();
              c = created;
              chatsCreated++;
              logger.info({ phone, convId: c.id, workspaceId }, "History sync: created conversation from message (no chat entry)");
            } catch (ie: any) {
              if (ie?.code === "23505") {
                c = await db.query.conversationsTable.findFirst({ where: and(eq(conversationsTable.contactPhone, phone), eq(conversationsTable.workspaceId, workspaceId)) });
              } else throw ie;
            }
          }
          if (c) convCache.set(phone, { id: c.id, lastMessageAt: c.lastMessageAt });
          else continue;
        }
        const conv = convCache.get(phone)!;

        const viewOnceInner = msg.message?.viewOnceMessage?.message ?? msg.message?.viewOnceMessageV2?.message ?? null;
        const effectiveMsg  = viewOnceInner ?? msg.message;
        const text =
          effectiveMsg?.conversation ||
          effectiveMsg?.extendedTextMessage?.text ||
          effectiveMsg?.imageMessage?.caption ||
          effectiveMsg?.videoMessage?.caption ||
          effectiveMsg?.documentMessage?.caption ||
          "";

        let mediaKind: string | null = null;
        let mediaMimeType: string | null = null;
        let mediaName: string | null = null;
        let contactJson: string | null = null;
        let contactDisplayText: string | null = null;
        if      (effectiveMsg?.imageMessage)         { mediaKind = "image";    mediaMimeType = effectiveMsg.imageMessage.mimetype    ?? "image/jpeg"; }
        else if (effectiveMsg?.audioMessage)         { mediaKind = "audio";    mediaMimeType = effectiveMsg.audioMessage.mimetype    ?? "audio/ogg"; }
        else if (effectiveMsg?.videoMessage)         { mediaKind = "video";    mediaMimeType = effectiveMsg.videoMessage.mimetype    ?? "video/mp4"; }
        else if (effectiveMsg?.documentMessage)      { mediaKind = "document"; mediaMimeType = effectiveMsg.documentMessage.mimetype ?? "application/octet-stream"; mediaName = effectiveMsg.documentMessage.fileName ?? null; }
        else if (effectiveMsg?.stickerMessage)       { mediaKind = "sticker"; }
        else if (effectiveMsg?.locationMessage || effectiveMsg?.liveLocationMessage) { mediaKind = "location"; }
        else if (effectiveMsg?.contactMessage || effectiveMsg?.contactsArrayMessage) {
          mediaKind = "contact";
          const vcardStrings: string[] = [];
          if (effectiveMsg.contactMessage?.vcard)
            vcardStrings.push(effectiveMsg.contactMessage.vcard);
          else if (effectiveMsg.contactsArrayMessage?.contacts)
            for (const c of effectiveMsg.contactsArrayMessage.contacts) if (c.vcard) vcardStrings.push(c.vcard);
          if (vcardStrings.length > 0) {
            const parsed = parseVCards(vcardStrings);
            contactJson = JSON.stringify(parsed);
            contactDisplayText = vcardStrings.length === 1
              ? contactDisplayName(parsed[0])
              : `${vcardStrings.length} contactos`;
          }
        }
        else if (effectiveMsg?.reactionMessage) {
          // History-sync: store reaction against its target message if we have it
          const targetWaId = effectiveMsg.reactionMessage.key?.id;
          const reactEmoji  = effectiveMsg.reactionMessage.text ?? "";
          if (targetWaId) {
            try {
              const [targetMsg] = await db.select({ id: messagesTable.id })
                .from(messagesTable)
                .where(and(eq(messagesTable.whatsappId, targetWaId), eq(messagesTable.workspaceId, workspaceId)))
                .limit(1);
              if (targetMsg) {
                await db.insert(messageReactionsTable).values({
                  workspaceId, messageId: targetMsg.id, emoji: reactEmoji,
                  senderJid: resolvedJid, fromMe: msg.key?.fromMe ?? false, reactedAt: new Date(),
                }).onConflictDoUpdate({
                  target: [messageReactionsTable.messageId, messageReactionsTable.senderJid],
                  set: { emoji: reactEmoji, reactedAt: new Date() },
                });
              }
            } catch (e) {
              logger.warn({ err: e, workspaceId }, "History sync: failed to store reaction");
            }
          }
          continue;
        }

        if (!text && !mediaKind) continue;

        const tsRaw = msg.messageTimestamp;
        const sentAt = tsRaw
          ? new Date((typeof tsRaw === "number" ? tsRaw : (tsRaw as any).toNumber?.() ?? 0) * 1000)
          : new Date();

        const direction: string = msg.key?.fromMe ? "outbound" : "inbound";

        const contentText = contactDisplayText || text || `[${mediaKind}]`;
        const [inserted] = await db.insert(messagesTable).values({
          workspaceId,
          conversationId: conv.id,
          content: contentText,
          direction,
          mediaType: mediaKind ?? "text",
          mediaMimeType,
          mediaName,
          mediaData: contactJson,
          sentAt,
          isRead: true,
          aiGenerated: false,
          whatsappId: waId,
          status: "sent",
        }).onConflictDoNothing().returning({ id: messagesTable.id });

        if (!inserted) { msgsDuplicate++; continue; }
        msgsImported++;

        // Use >= so that the most recent message always overwrites the empty placeholder.
        if (sentAt >= conv.lastMessageAt) {
          await db.update(conversationsTable)
            .set({ lastMessage: contentText, lastMessageAt: sentAt })
            .where(eq(conversationsTable.id, conv.id));
          convCache.set(phone, { id: conv.id, lastMessageAt: sentAt });
        }
      } catch (e) {
        logger.warn({ err: e, workspaceId }, "Error importing message from history");
        errors++;
      }
    }

    logger.info(
      { chatsCreated, chatsSkipped, msgsImported, msgsDuplicate, errors, syncType, isLatest, workspaceId },
      "History sync complete"
    );
    addEvent(workspaceId, `Historial importado: ${chatsCreated} conv nuevas · ${msgsImported} mensajes nuevos · ${msgsDuplicate} duplicados omitidos`);

    // ── Repair any conversations that still have an empty lastMessage preview ──
    // This can happen when the chat-list sync created a conversation row before
    // the message-loop ran (or when the strict > comparison missed the boundary).
    try {
      await db.execute(sql`
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
        WHERE c.id             = sub.conversation_id
          AND c.workspace_id   = ${workspaceId}
          AND (c.last_message IS NULL OR c.last_message = '')
      `);
    } catch (e) {
      logger.warn({ err: e, workspaceId }, "Post-sync lastMessage repair failed (non-fatal)");
    }

    if (chatsCreated > 0 || msgsImported > 0) {
      emit(workspaceId, "conversations:synced", { chatsCreated, msgsImported });
    }
  });

  // ── ACK / delivery receipts ───────────────────────────────────────────────
  sock.ev.on("messages.update", async (updates: any[]) => {
    for (const { key, update } of updates) {
      if (!key.fromMe) continue;
      const ackStatus: number | undefined = update?.status;
      if (!ackStatus || !key.id) continue;

      let newStatus: string | null = null;
      if (ackStatus >= 4) {
        newStatus = "read";
      } else if (ackStatus === 3) {
        newStatus = "delivered";
      } else if (ackStatus === 2) {
        newStatus = "sent";
      }

      if (!newStatus) continue;

      try {
        const { and: drizzleAnd } = await import("drizzle-orm");
        const [dbMsg] = await db.select({
          id: messagesTable.id,
          conversationId: messagesTable.conversationId,
          status: messagesTable.status,
        })
          .from(messagesTable)
          .where(drizzleAnd(
            eq(messagesTable.whatsappId, key.id),
            eq(messagesTable.direction, "outbound"),
          ))
          .limit(1);

        if (!dbMsg) continue;

        const order = ["pending", "sending", "sent", "delivered", "read"];
        const current = order.indexOf(dbMsg.status ?? "sent");
        const next = order.indexOf(newStatus);
        if (next <= current) continue;

        await db.update(messagesTable)
          .set({ status: newStatus })
          .where(eq(messagesTable.id, dbMsg.id));

        emit(workspaceId, "message:status_changed", {
          messageId: dbMsg.id,
          conversationId: dbMsg.conversationId,
          status: newStatus,
        });

        logger.info({ waId: key.id, msgId: dbMsg.id, status: newStatus, workspaceId }, "ACK received");
      } catch (e) {
        logger.error({ err: e, workspaceId }, "Error processing ACK update");
      }
    }
  });

  sock.ev.on("messages.upsert", async (m: any) => {
    if (m.type !== "notify" && m.type !== "append") return;
    for (const msg of m.messages) {
      // rawJid MUST be declared first — used by the isFromMe branch below.
      // (Previously declared after the isFromMe check, causing a TDZ ReferenceError
      // on every fromMe:true message and breaking Baileys' event queue on first login.)
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === "status@broadcast") continue;

      // fromMe:true means we sent this message (from this app OR from the phone).
      // We keep processing it — the whatsappId unique-constraint deduplication below
      // will silently skip echoes of messages already stored by startConversation/sendMessage.
      const isFromMe = !!(msg.key?.fromMe);
      if (!isFromMe) {
        ws.lastMessageReceivedAt = new Date();
      } else if (!rawJid.endsWith("@g.us") && !rawJid.endsWith("@lid")) {
        ws.lastSentAt = new Date();
        ws.lastSentPhone = rawJid.replace(/@.*/, "") ?? null;
      }

      if (rawJid.endsWith("@g.us")) {
        logger.debug({ jid: rawJid, workspaceId }, "Skipping group message");
        continue;
      }
      let jid = rawJid;
      if (rawJid.endsWith("@lid")) {
        const fromMap = ws.lidToJid.get(rawJid);
        const fromSignalStore = fromMap ? null : await _resolveLidViaSignalStore(sock, rawJid);
        if (fromMap) {
          jid = fromMap;
          logger.info({ lid: rawJid, resolved: jid, workspaceId }, "Resolved @lid to real phone JID (from contact map)");
        } else if (fromSignalStore) {
          jid = fromSignalStore;
          ws.lidToJid.set(rawJid, jid);
          logger.info({ lid: rawJid, resolved: jid, workspaceId }, "Resolved @lid to real phone JID (from Baileys signal store)");
        } else {
          const sockContacts: Record<string, any> = (sock as any).contacts ?? {};
          const entry = Object.entries(sockContacts).find(
            ([, c]) => c?.lid === rawJid && c?.id?.endsWith("@s.whatsapp.net")
          );
          if (entry) {
            jid = entry[1].id as string;
            ws.lidToJid.set(rawJid, jid);
            logger.info({ lid: rawJid, resolved: jid, workspaceId }, "Resolved @lid to real phone JID (from sock.contacts)");
          } else {
            const lidConvRows = await db
              .select({ contactPhone: conversationsTable.contactPhone })
              .from(conversationsTable)
              .where(eq(conversationsTable.whatsappJid, rawJid))
              .limit(2);
            if (lidConvRows.length === 1) {
              jid = `${lidConvRows[0].contactPhone}@s.whatsapp.net`;
              ws.lidToJid.set(rawJid, jid);
              logger.info({ lid: rawJid, resolved: jid, workspaceId }, "Resolved @lid to real phone JID (from DB conversation)");
            } else {
              if (lidConvRows.length > 1) {
                logger.warn({ lid: rawJid, workspaceId }, "Ambiguous @lid — multiple DB conversations match, skipping to avoid mis-routing");
              } else {
                const alreadyDeferred = ws.deferredLidMessages.some(d => d.lid === rawJid);
                if (!alreadyDeferred) {
                  logger.info({ lid: rawJid, workspaceId }, "Deferring @lid message — waiting for contacts.set to populate map");
                  ws.deferredLidMessages.push({ sock, msg, lid: rawJid });
                } else {
                  logger.warn({ lid: rawJid, workspaceId }, "Received @lid message but couldn't resolve to real phone — skipping to avoid phantom conversation");
                }
              }
              continue;
            }
          }
        }
      }

      const phone = normalizeInboundPhone(jid.replace(/@.*/, ""));
      const direction = isFromMe ? "outbound" : "inbound";

      const viewOnceInner =
        msg.message?.viewOnceMessage?.message ??
        msg.message?.viewOnceMessageV2?.message ??
        null;
      const effectiveMsg = viewOnceInner ?? msg.message;

      const text =
        effectiveMsg?.conversation ||
        effectiveMsg?.extendedTextMessage?.text ||
        effectiveMsg?.imageMessage?.caption ||
        effectiveMsg?.videoMessage?.caption ||
        effectiveMsg?.documentMessage?.caption ||
        effectiveMsg?.audioMessage?.caption ||
        "";

      type MediaKind =
        | "image" | "audio" | "video" | "document" | "sticker"
        | "location" | "contact" | "reaction" | "poll"
        | null;
      let mediaKind: MediaKind = null;
      let mediaMimeType: string | null = null;
      let mediaName: string | null = null;
      let contactJsonRT: string | null = null;
      let contactDisplayTextRT: string | null = null;

      if (effectiveMsg?.imageMessage)         { mediaKind = "image";    mediaMimeType = effectiveMsg.imageMessage.mimetype ?? "image/jpeg"; }
      else if (effectiveMsg?.audioMessage)    { mediaKind = "audio";    mediaMimeType = effectiveMsg.audioMessage.mimetype ?? "audio/ogg"; }
      else if (effectiveMsg?.videoMessage)    { mediaKind = "video";    mediaMimeType = effectiveMsg.videoMessage.mimetype ?? "video/mp4"; }
      else if (effectiveMsg?.documentMessage) { mediaKind = "document"; mediaMimeType = effectiveMsg.documentMessage.mimetype ?? "application/octet-stream"; mediaName = effectiveMsg.documentMessage.fileName ?? null; }
      else if (effectiveMsg?.stickerMessage)  { mediaKind = "sticker";  mediaMimeType = "image/webp"; }
      else if (effectiveMsg?.locationMessage || effectiveMsg?.liveLocationMessage) {
        mediaKind = "location";
      }
      else if (effectiveMsg?.contactMessage || effectiveMsg?.contactsArrayMessage) {
        mediaKind = "contact";
        const vcardStrings: string[] = [];
        if (effectiveMsg.contactMessage?.vcard)
          vcardStrings.push(effectiveMsg.contactMessage.vcard);
        else if (effectiveMsg.contactsArrayMessage?.contacts)
          for (const c of effectiveMsg.contactsArrayMessage.contacts) if (c.vcard) vcardStrings.push(c.vcard);
        if (vcardStrings.length > 0) {
          const parsed = parseVCards(vcardStrings);
          contactJsonRT = JSON.stringify(parsed);
          contactDisplayTextRT = vcardStrings.length === 1
            ? contactDisplayName(parsed[0])
            : `${vcardStrings.length} contactos`;
        }
      }
      else if (effectiveMsg?.reactionMessage) {
        // Real-time inbound: store the reaction and emit a socket event
        const targetWaId = effectiveMsg.reactionMessage.key?.id;
        const reactEmoji  = effectiveMsg.reactionMessage.text ?? "";
        if (targetWaId) {
          try {
            const [targetMsg] = await db.select({ id: messagesTable.id })
              .from(messagesTable)
              .where(and(eq(messagesTable.whatsappId, targetWaId), eq(messagesTable.workspaceId, workspaceId)))
              .limit(1);
            if (targetMsg) {
              await db.insert(messageReactionsTable).values({
                workspaceId, messageId: targetMsg.id, emoji: reactEmoji,
                senderJid: jid, fromMe: msg.key?.fromMe ?? false, reactedAt: new Date(),
              }).onConflictDoUpdate({
                target: [messageReactionsTable.messageId, messageReactionsTable.senderJid],
                set: { emoji: reactEmoji, reactedAt: new Date() },
              });
              emit(workspaceId, "message:reaction", {
                messageId: targetMsg.id, emoji: reactEmoji,
                fromMe: msg.key?.fromMe ?? false, senderJid: jid,
              });
              logger.debug({ phone, waId: msg.key.id, workspaceId, reactEmoji }, "Inbound reaction stored");
            } else {
              logger.debug({ phone, waId: msg.key.id, workspaceId }, "Inbound reaction: target message not found locally");
            }
          } catch (e) {
            logger.warn({ err: e, workspaceId }, "Failed to store inbound reaction");
          }
        }
        continue;
      }
      else if (effectiveMsg?.pollCreationMessage || effectiveMsg?.pollCreationMessageV2 || effectiveMsg?.pollCreationMessageV3) {
        mediaKind = "poll";
      }

      if (!text && !mediaKind) {
        logger.warn(
          { phone, waId: msg.key.id, msgKeys: Object.keys(effectiveMsg ?? {}), workspaceId },
          "Inbound message has no text and no recognised media type — skipping (add handler if this type should be stored)"
        );
        continue;
      }

      const msgWaId = msg.key.id ?? null;
      if (msgWaId) {
        const [dup] = await db
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(eq(messagesTable.whatsappId, msgWaId))
          .limit(1);
        if (dup) {
          logger.debug({ waId: msgWaId, phone, workspaceId }, "Duplicate inbound message — already stored, skipping");
          continue;
        }
      }

      try {
        const preview = text || `[${mediaKind ?? "mensaje"}]`;
        let conv = await db.query.conversationsTable.findFirst({
          where: and(eq(conversationsTable.contactPhone, phone), eq(conversationsTable.workspaceId, workspaceId)),
        });
        // Extract real WA timestamp here so it's available for both the conversation
        // update block and the final message insert.
        const tsRawUpsert = msg.messageTimestamp;
        const msgSentAt = tsRawUpsert
          ? new Date((typeof tsRawUpsert === "number" ? tsRawUpsert : (tsRawUpsert as any).toNumber?.() ?? 0) * 1000)
          : new Date();

        // ── Auto-link: find existing CRM client by normalized phone ──────────
        // Runs when there is no conversation yet, or the existing one has no
        // clientId (e.g. created before the client was added, or after a DB reset).
        // This is what makes known contacts appear with their name + photo
        // automatically, without pressing the manual Sync button.
        const _rawPhoneForLog = jid.replace(/@.*/, "");
        let autoLinkedClient: { id: number; name: string; profilePicUrl: string | null } | null = null;

        if (!conv?.clientId) {
          try {
            const [_c] = await db
              .select({ id: clientsTable.id, name: clientsTable.name, profilePicUrl: clientsTable.profilePicUrl })
              .from(clientsTable)
              .where(and(eq(clientsTable.workspaceId, workspaceId), eq(clientsTable.phone, phone)))
              .limit(1);
            autoLinkedClient = _c ?? null;
          } catch (_e) {
            logger.warn({ err: _e, phone, workspaceId }, "[AUDIT] Error en lookup de cliente por teléfono");
          }
        }

        // ── Diagnostic log (audit) ────────────────────────────────────────────
        logger.info({
          workspaceId,
          numeroRecibido: _rawPhoneForLog,
          numeroNormalizado: phone,
          convId: conv?.id ?? null,
          clienteEncontrado: !!autoLinkedClient,
          clientIdAsignado: autoLinkedClient?.id ?? conv?.clientId ?? null,
          nombreMostrado: autoLinkedClient?.name ?? conv?.contactName ?? null,
        }, autoLinkedClient
          ? `[AUDIT] Número: ${_rawPhoneForLog} → normalizado: ${phone} → cliente encontrado: "${autoLinkedClient.name}" (id=${autoLinkedClient.id})`
          : conv?.clientId
          ? `[AUDIT] Número: ${_rawPhoneForLog} → normalizado: ${phone} → conversación ya vinculada (clientId=${conv.clientId})`
          : `[AUDIT] Número: ${_rawPhoneForLog} → normalizado: ${phone} → sin coincidencia en CRM (teléfono distinto o cliente inexistente)`
        );

        let isNewConversation = false;

        // If the existing conversation lacks a clientId but we just found one,
        // patch it now (fire-and-forget so we don't block the message flow).
        if (conv && !conv.clientId && autoLinkedClient) {
          const _cid = conv.id;
          const _client = autoLinkedClient;
          (async () => {
            try {
              await db.update(conversationsTable)
                .set({
                  clientId: _client.id,
                  contactName: _client.name,
                  ...(_client.profilePicUrl ? { contactAvatar: _client.profilePicUrl } : {}),
                })
                .where(and(eq(conversationsTable.id, _cid), eq(conversationsTable.workspaceId, workspaceId)));
              logger.info({ convId: _cid, clientId: _client.id, workspaceId }, "[AUDIT] Conversación existente vinculada automáticamente al cliente");
            } catch (_e) {
              logger.warn({ err: _e, convId: _cid, workspaceId }, "[AUDIT] Error al vincular conversación existente al cliente");
            }
          })();
          // Update local ref so downstream code (logClientEvent etc.) sees the clientId
          conv = { ...conv, clientId: _client.id, contactName: _client.name };
        }

        if (!conv) {
          try {
            const [newConv] = await db.insert(conversationsTable).values({
              workspaceId,
              contactName: autoLinkedClient?.name || msg.pushName || phone,
              contactPhone: phone,
              lastMessage: preview,
              lastMessageAt: new Date(),
              unreadCount: 1,
              whatsappJid: jid,
              status: "active",
              ...(autoLinkedClient ? {
                clientId: autoLinkedClient.id,
                contactAvatar: autoLinkedClient.profilePicUrl ?? undefined,
              } : {}),
            }).returning();
            conv = newConv;
            isNewConversation = true;
            logger.info({ phone, convId: conv.id, pushName: msg.pushName, clientId: autoLinkedClient?.id ?? null, workspaceId }, "[AUDIT] Nueva conversación creada" + (autoLinkedClient ? ` y vinculada automáticamente a cliente id=${autoLinkedClient.id}` : " (sin cliente en CRM)"));

            // Fire-and-forget: fetch WA profile photo for this new unknown contact
            // so the avatar shows immediately in the sidebar even before they're saved as a client.
            const _convIdForPhoto = newConv.id;
            (async () => {
              try {
                const photoUrl: string | undefined = await sock.profilePictureUrl(jid, "image");
                if (photoUrl) {
                  await db.update(conversationsTable)
                    .set({ contactAvatar: photoUrl })
                    .where(and(eq(conversationsTable.id, _convIdForPhoto), eq(conversationsTable.workspaceId, workspaceId)));
                }
              } catch { /* private / not on WA — silently skip */ }
            })();
          } catch (insertErr: any) {
            if (insertErr?.code === "23505") {
              let fetched: typeof conv | undefined;
              for (let attempt = 0; attempt < 3; attempt++) {
                fetched = await db.query.conversationsTable.findFirst({
                  where: and(eq(conversationsTable.contactPhone, phone), eq(conversationsTable.workspaceId, workspaceId)),
                });
                if (fetched) break;
                await new Promise<void>(r => setTimeout(r, 50 * (attempt + 1)));
              }
              if (!fetched) {
                logger.error({ phone, err: insertErr, workspaceId }, "Unique violation on conversation insert but row not found after 3 retries — this message will be lost; investigate DB replication lag");
                continue;
              }
              conv = fetched;
              logger.info({ phone, convId: conv.id, workspaceId }, "Conversation created by concurrent insert — reusing after retry");
            } else {
              throw insertErr;
            }
          }
        }

        if (isFromMe) {
          // Outbound message sent from the phone — just update the preview; don't
          // touch unread count or conversation status timers.
          await db.update(conversationsTable).set({
            lastMessage: preview,
            lastMessageAt: msgSentAt,
            whatsappJid: jid,
          }).where(eq(conversationsTable.id, conv!.id));
        } else if (isNewConversation) {
          await scheduleWaiting(workspaceId, conv!.id, "active");
        } else {
          // Cancel any pending "sin respuesta" timer — client replied before it fired
          cancelUnanswered(workspaceId, conv!.id);

          // ── Reopen resolved conversations ─────────────────────────────────
          // A new inbound message on a resolved conversation means the client
          // has more to say — bring it back to "waiting" so the operator sees
          // it in the active inbox.
          const wasResolved = conv!.status === "resolved";
          const effectiveStatus = wasResolved ? "waiting" : conv!.status;
          if (wasResolved) {
            logger.info({ conversationId: conv!.id }, "Resolved conversation reopened by new inbound message");
          }

          // Update metadata (lastMessage, unreadCount) and reopen if resolved — single write
          await db.update(conversationsTable).set({
            lastMessage: preview,
            lastMessageAt: msgSentAt,
            unreadCount: (conv!.unreadCount || 0) + 1,
            contactName: msg.pushName || conv!.contactName,
            whatsappJid: jid,
            ...(wasResolved ? { status: "waiting" } : {}),
          }).where(eq(conversationsTable.id, conv!.id));
          // scheduleWaiting handles delay + guards manual statuses + emits conversation:updated
          await scheduleWaiting(workspaceId, conv!.id, effectiveStatus);
        }

        let mediaData: string | null = null;
        if (mediaKind === "contact") {
          // Contacts carry their data as vCard text — no download needed
          mediaData = contactJsonRT;
        } else if (mediaKind && mediaKind !== "video") {
          try {
            const { downloadMediaMessage } = await import("@whiskeysockets/baileys") as any;
            let buffer: Buffer;
            try {
              buffer = await downloadMediaMessage(msg, "buffer", {}, { reuploadRequest: sock.updateMediaMessage });
            } catch (firstErr) {
              await new Promise((r) => setTimeout(r, 1500));
              buffer = await downloadMediaMessage(msg, "buffer", {}, { reuploadRequest: sock.updateMediaMessage });
            }
            const MAX_BYTES = 5 * 1024 * 1024;
            if (buffer.length <= MAX_BYTES) {
              mediaData = buffer.toString("base64");
            } else {
              logger.warn({ convId: conv.id, kind: mediaKind, bytes: buffer.length, workspaceId }, "Media too large — skipping storage");
            }
          } catch (e) {
            logger.warn({ err: e, kind: mediaKind, workspaceId }, "Media download failed");
          }
        }

        const [savedMsg] = await db.insert(messagesTable).values({
          workspaceId,
          conversationId: conv.id,
          content: contactDisplayTextRT || text || `[${mediaKind}]`,
          direction,
          mediaType: mediaKind ?? "text",
          mediaMimeType,
          mediaName,
          mediaData,
          sentAt: msgSentAt,
          isRead: isFromMe,       // our own messages are always "read"
          aiGenerated: false,
          whatsappId: msg.key.id,
          status: isFromMe ? "sent" : undefined,
        }).returning({ id: messagesTable.id });

        logger.info(
          {
            msgId: savedMsg.id,
            waId: msg.key.id,
            convId: conv.id,
            phone,
            pushName: msg.pushName,
            mediaKind: mediaKind ?? "text",
            isNewConversation,
            mediaStored: !!mediaData,
            workspaceId,
          },
          "Inbound message stored ✓"
        );

        await _logActivity(workspaceId, "message_received", `Mensaje de ${msg.pushName || phone}`, msg.pushName || phone);
        if (conv!.clientId) {
          const kind = mediaKind ?? "text";
          logClientEvent({
            workspaceId,
            clientId: conv!.clientId,
            type: kind === "audio" ? "audio_received" : kind === "text" ? "message_received" : "file_received",
            detail: text || `Archivo recibido (${kind})`,
            actor: msg.pushName || phone,
            relatedType: "message",
            relatedId: savedMsg.id,
          });
        }

        emit(workspaceId, "message:new", {
          conversationId: conv.id,
          contactName: msg.pushName || conv.contactName || phone,
          preview: preview.length > 80 ? preview.substring(0, 80) + "…" : preview,
          mediaType: mediaKind,
          messageId: savedMsg.id,
        });

        if (!isFromMe) {
          if (text) _classifyMessage(workspaceId, conv.id, text, msg.pushName || conv.contactName || phone);
          if (_shouldAutoReply(workspaceId) && (text || mediaKind === "audio")) {
            await _handleAutoReply(workspaceId, sock, jid, conv.id, text || `[${mediaKind}]`, msg.pushName || phone);
          }
        }
      } catch (e) {
        logger.error({ err: e, workspaceId }, "Error processing incoming message");
      }
    }
  });
}

// ─── Fase 1: Send media message ──────────────────────────────────────────────

async function _transcodeAudioToOggOpus(buffer: Buffer, sourceMimeType: string): Promise<Buffer> {
  const ext = sourceMimeType.includes("webm") ? "webm"
    : sourceMimeType.includes("mp4") || sourceMimeType.includes("m4a") ? "m4a"
    : sourceMimeType.includes("ogg") ? "ogg"
    : sourceMimeType.includes("wav") ? "wav"
    : "bin";
  const id = randomUUID();
  const inPath = join(tmpdir(), `wa-audio-in-${id}.${ext}`);
  const outPath = join(tmpdir(), `wa-audio-out-${id}.ogg`);
  await writeFile(inPath, buffer);
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const proc = spawn("ffmpeg", [
        "-y",
        "-i", inPath,
        "-c:a", "libopus",
        "-ar", "48000",
        "-ac", "1",
        "-b:a", "32k",
        "-f", "ogg",
        outPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", rejectPromise);
      proc.on("close", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });
    });
    return await readFile(outPath);
  } finally {
    await rm(inPath, { force: true });
    await rm(outPath, { force: true });
  }
}

/** Send a media file (image, document, audio) to a WhatsApp conversation. */
export async function sendMediaMessage(
  workspaceId: number,
  conversationId: number,
  mediaKind: "image" | "document" | "audio",
  base64: string,
  mimeType: string,
  fileName?: string,
  caption?: string,
): Promise<{ id: number; status: string }> {
  const ws = getOrCreateState(workspaceId);
  cancelPendingAutoReply(workspaceId, conversationId);
  cancelWaiting(workspaceId, conversationId);

  const conv = await db.query.conversationsTable.findFirst({
    where: and(eq(conversationsTable.id, conversationId), eq(conversationsTable.workspaceId, workspaceId)),
  });

  const isConnected = ws.state === "connected" && !!ws.client && !!conv?.whatsappJid;
  const buffer = Buffer.from(base64, "base64");

  const [msg] = await db.insert(messagesTable).values({
    workspaceId,
    conversationId,
    content: caption || fileName || `[${mediaKind}]`,
    direction: "outbound",
    mediaType: mediaKind,
    mediaMimeType: mimeType,
    mediaName: fileName ?? null,
    mediaData: base64,
    sentAt: new Date(),
    isRead: true,
    aiGenerated: false,
    status: isConnected ? "sending" : "pending",
  }).returning({ id: messagesTable.id, status: messagesTable.status });

  if (conv?.clientId) {
    logClientEvent({
      workspaceId,
      clientId: conv.clientId,
      type: mediaKind === "audio" ? "audio_sent" : "file_sent",
      detail: caption || fileName || `Archivo enviado (${mediaKind})`,
      actor: "Operador", relatedType: "message", relatedId: msg.id,
    });
  }

  emit(workspaceId, "message:new", {
    conversationId,
    contactName: conv?.contactName ?? "",
    preview: caption || fileName || `[${mediaKind}]`,
    direction: "outbound",
    messageId: msg.id,
    status: msg.status,
    mediaType: mediaKind,
  });

  await db.update(conversationsTable)
    .set({ lastMessage: caption || fileName || `[${mediaKind}]`, lastMessageAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));
  await scheduleUnanswered(workspaceId, conversationId);
  maybeMarkResolved(workspaceId, conversationId, caption || fileName || `[${mediaKind}]`).catch(() => {});

  let finalStatus: string = isConnected ? "sending" : "pending";

  if (isConnected) {
    try {
      let waPayload: Record<string, unknown>;
      if (mediaKind === "image") {
        waPayload = { image: buffer, mimetype: mimeType, caption: caption ?? "" };
      } else if (mediaKind === "audio") {
        const audioBuffer = await _transcodeAudioToOggOpus(buffer, mimeType);
        const audioMime = "audio/ogg; codecs=opus";
        if (DEBUG_WA) debugLog(workspaceId, "Audio transcoded to ogg/opus for outbound send", { conversationId, originalMime: mimeType, transcodedBytes: audioBuffer.length });
        await db.update(messagesTable).set({
          mediaMimeType: audioMime,
          mediaData: audioBuffer.toString("base64"),
        }).where(eq(messagesTable.id, msg.id));
        waPayload = { audio: audioBuffer, mimetype: audioMime, ptt: true };
      } else {
        waPayload = { document: buffer, mimetype: mimeType, fileName: fileName ?? "file" };
      }
      const waResult = await (ws.client as any).sendMessage(conv!.whatsappJid!, waPayload);
      const waId: string | null = waResult?.key?.id ?? null;
      finalStatus = "sent";
      await db.update(messagesTable).set({ status: "sent", whatsappId: waId }).where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "sent" });
    } catch (e) {
      logger.error({ err: e, conversationId, mediaKind, workspaceId }, "Failed to send media via WhatsApp");
      finalStatus = "failed";
      await db.update(messagesTable).set({ status: "failed" }).where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "failed" });
    }
  }

  return { id: msg.id, status: finalStatus };
}

// ─── Send a vCard contact to a WhatsApp conversation ─────────────────────────
// contacts: array of { displayName, vcard } — WhatsApp supports 1 or many.
export async function sendContactMessage(
  workspaceId: number,
  conversationId: number,
  contacts: { displayName: string; vcard: string }[],
): Promise<{ id: number; status: string }> {
  if (!contacts.length) throw new Error("contacts array must not be empty");

  const ws = getOrCreateState(workspaceId);
  cancelPendingAutoReply(workspaceId, conversationId);
  cancelWaiting(workspaceId, conversationId);

  const conv = await db.query.conversationsTable.findFirst({
    where: and(eq(conversationsTable.id, conversationId), eq(conversationsTable.workspaceId, workspaceId)),
  });

  const isConnected = ws.state === "connected" && !!ws.client && !!conv?.whatsappJid;

  const displayName = contacts.length === 1
    ? contacts[0].displayName
    : `${contacts.length} contactos`;

  // Parse the raw vCards so we store the same structured JSON as received contacts.
  const parsed = parseVCards(contacts.map(c => c.vcard));
  const mediaData = JSON.stringify(parsed);

  const [msg] = await db.insert(messagesTable).values({
    workspaceId,
    conversationId,
    content: displayName,
    direction: "outbound",
    mediaType: "contact",
    mediaData,
    sentAt: new Date(),
    isRead: true,
    aiGenerated: false,
    status: isConnected ? "sending" : "pending",
  }).returning({ id: messagesTable.id, status: messagesTable.status });

  emit(workspaceId, "message:new", {
    conversationId,
    contactName: conv?.contactName ?? "",
    preview: displayName,
    direction: "outbound",
    messageId: msg.id,
    status: msg.status,
    mediaType: "contact",
  });

  await db.update(conversationsTable)
    .set({ lastMessage: displayName, lastMessageAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));
  await scheduleUnanswered(workspaceId, conversationId);

  if (isConnected) {
    try {
      const waResult = await (ws.client as any).sendMessage(conv!.whatsappJid!, {
        contacts: {
          displayName,
          contacts: contacts.map(c => ({ vcard: c.vcard })),
        },
      });
      const waId: string | null = waResult?.key?.id ?? null;
      await db.update(messagesTable)
        .set({ status: "sent", whatsappId: waId })
        .where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "sent" });
    } catch (e) {
      logger.error({ err: e, workspaceId, conversationId }, "Failed to send contact via WhatsApp");
      await db.update(messagesTable).set({ status: "failed" }).where(eq(messagesTable.id, msg.id));
      emit(workspaceId, "message:status_changed", { messageId: msg.id, conversationId, status: "failed" });
    }
  }

  return { id: msg.id, status: isConnected ? "sent" : "pending" };
}

export function classifyMessage(workspaceId: number, conversationId: number, text: string, contactName: string) {
  import("./ai").then(({ processIncomingMessage }) => {
    processIncomingMessage(conversationId, text, contactName).then((result) => {
      if (result) {
        emit(workspaceId, "conversation:updated", { id: conversationId });
      }
    }).catch((e) => { logger.warn({ err: e, conversationId, workspaceId }, "Message classification failed"); });
  }).catch((e) => { logger.warn({ err: e, workspaceId }, "AI module import failed for classification"); });
}

/** @deprecated Internal alias kept so call sites in this file don't break. */
function _classifyMessage(workspaceId: number, conversationId: number, text: string, contactName: string) {
  classifyMessage(workspaceId, conversationId, text, contactName);
}

async function _handleAutoReply(workspaceId: number, sock: any, jid: string, conversationId: number, _text: string, name: string) {
  const ws = getOrCreateState(workspaceId);
  cancelWaiting(workspaceId, conversationId);
  const mode = ws.agentMode;
  if (mode === "solidario") {
    let wasCancelled = false;
    try {
      const { aiSettingsTable: s } = await import("@workspace/db");
      const [settings] = await db.select({ delay: s.responseDelaySeconds }).from(s).limit(1);
      const delayMs = ((settings?.delay ?? 3)) * 1000;
      let pendingRef: PendingReply | null = null;
      await new Promise<void>((resolveDelay) => {
        const pending: PendingReply = {
          timer: setTimeout(() => {
            ws.pendingAutoReplies.delete(conversationId);
            resolveDelay();
          }, delayMs),
          resolve: resolveDelay,
          cancelled: false,
        };
        pendingRef = pending;
        ws.pendingAutoReplies.set(conversationId, pending);
      });
      wasCancelled = (pendingRef as PendingReply | null)?.cancelled ?? false;
    } catch (e) {
      logger.warn({ err: e, workspaceId }, "Could not read responseDelaySeconds — proceeding without delay");
    }
    if (wasCancelled || !_shouldAutoReply(workspaceId)) return;
  }

  // ── Agent validation — same check as Prueba IA, single source of truth ──────
  try {
    const { hasActiveAgents } = await import("./agentValidation");
    if (!await hasActiveAgents(workspaceId)) {
      logger.info({ workspaceId }, "Respuesta automática omitida: no existen agentes IA activos.");
      return;
    }
  } catch (e) {
    logger.warn({ err: e, workspaceId }, "Agent validation check failed — proceeding with auto-reply");
  }

  try {
    const { generateAISuggestion } = await import("./ai");
    const suggestion = await generateAISuggestion(conversationId, _text);
    if (suggestion) {
      await sock.sendMessage(jid, { text: suggestion });
      const [autoMsg] = await db.insert(messagesTable).values({
        workspaceId,
        conversationId,
        content: suggestion,
        direction: "outbound",
        sentAt: new Date(),
        isRead: true,
        aiGenerated: true,
      }).returning({ id: messagesTable.id });
      await db.update(conversationsTable)
        .set({ lastMessage: suggestion, lastMessageAt: new Date() })
        .where(eq(conversationsTable.id, conversationId));
      await scheduleUnanswered(workspaceId, conversationId);
      await _logActivity(workspaceId, "ai_reply", `Respuesta automática IA enviada a ${name}`, name);
      const [convForEvent] = await db.select({ clientId: conversationsTable.clientId }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));
      if (convForEvent?.clientId) {
        logClientEvent({
          workspaceId,
          clientId: convForEvent.clientId, type: "message_sent", detail: suggestion.substring(0, 160),
          actor: "IA",
        });
      }

      const preview = suggestion.length > 80 ? suggestion.substring(0, 80) + "…" : suggestion;
      emit(workspaceId, "message:new", {
        conversationId,
        contactName: name,
        preview,
        direction: "outbound",
        messageId: autoMsg.id,
      });
      emit(workspaceId, "conversation:updated", { id: conversationId });
    }
  } catch (e) {
    logger.error({ err: e, workspaceId }, "Auto-reply failed");
  }
}

async function _logActivity(workspaceId: number, type: string, description: string, clientName: string | null) {
  try {
    await db.insert(activityLogTable).values({ workspaceId, type, description, clientName });
  } catch (e) { logger.warn({ err: e, type, workspaceId }, "Activity log insert failed"); }
}
