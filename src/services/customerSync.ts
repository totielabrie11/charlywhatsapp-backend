/**
 * CustomerSyncService — two-phase CRM enrichment.
 *
 * Phase 1 · syncInteractions  — single bulk SQL UPDATE for lastContactAt.
 *                               Runs once per sync, completes in < 1 s.
 * Phase 2 · syncPhotos        — per-client WhatsApp profile-photo fetch.
 *
 * Architecture (per audit brief):
 * ✓ Single SyncState object per workspace — no scattered Maps.
 * ✓ Concurrency guard — only one sync per workspace at a time (also in route).
 * ✓ withTimeout clears its timer on success — no orphan Node handles.
 * ✓ Post-timeout cooldown (2 s) — Baileys drains pending WA responses before next call.
 * ✓ Per-client structured log line: [SYNC] Name | JID | Nms | result
 * ✓ Separate counters: updated / unchanged / noPhoto / timeout / error / skipped.
 * ✓ problematicJids[] accumulates timeout + error JIDs for pattern analysis.
 * ✓ SSE disconnect detection: caller sets cancelRequested via requestAbort().
 */

import { sql, eq, and } from "drizzle-orm";
import { db, clientsTable, conversationsTable } from "@workspace/db";
import { getActiveSocket } from "./whatsapp";
import { normalizePhone } from "../lib/phone";
import { logger } from "../lib/logger";

// ─── Public types ─────────────────────────────────────────────────────────────

export type PhotoStatus = "updated" | "unchanged" | "no_photo" | "timeout" | "error";

export interface ProblematicJid {
  name: string;
  jid: string;
  reason: string;
  durationMs: number;
}

/** Shape sent over SSE on every progress event and at completion. */
export interface PhotoStats {
  total: number;
  processed: number;
  photosUpdated: number;
  unchanged: number;
  noPhoto: number;
  skipped: number;
  timeouts: number;
  errors: number;
  currentName?: string;
  currentJid?: string;
  done?: boolean;
  durationMs?: number;
  problematicJids: ProblematicJid[];
}

/** Kept for backward compat with the route layer. */
export type PhotoProgressEvent = PhotoStats;
export type ProgressCallback = (event: PhotoProgressEvent) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard ceiling per profilePictureUrl call — never hangs longer than this. */
const PHOTO_TIMEOUT_MS = 7_000;

/** Delay between clients to avoid WhatsApp rate-limiting. */
const THROTTLE_MS = 300;

/**
 * Extra wait inserted after every timeout.
 * When profilePictureUrl times out the underlying Baileys promise is still
 * alive — it is waiting for a WA server response that never came.  Without a
 * pause, the next call starts immediately and Baileys accumulates pending
 * callbacks.  After enough timeouts the socket saturates and every subsequent
 * call is slow.  A short cooldown gives Baileys time to drain before we
 * proceed to the next client.
 */
const TIMEOUT_COOLDOWN_MS = 2_000;

// ─── Internal per-workspace state ─────────────────────────────────────────────

interface SyncState {
  running: boolean;
  cancelRequested: boolean;
  skipRequested: boolean;
  total: number;
  processed: number;
  photosUpdated: number;
  unchanged: number;
  noPhoto: number;
  skipped: number;
  timeouts: number;
  errors: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  problematicJids: ProblematicJid[];
  // ── Status-endpoint fields (for UI reconnect) ────────────────────────────
  phase: 1 | 2;
  currentName?: string;
  currentJid?: string;
  interactionsUpdated: number;
}

const _states = new Map<number, SyncState>();

function getOrCreate(workspaceId: number): SyncState {
  if (!_states.has(workspaceId)) {
    _states.set(workspaceId, {
      running: false, cancelRequested: false, skipRequested: false,
      total: 0, processed: 0, photosUpdated: 0, unchanged: 0, noPhoto: 0,
      skipped: 0, timeouts: 0, errors: 0,
      startedAt: null, finishedAt: null, problematicJids: [],
      phase: 1, currentName: undefined, currentJid: undefined, interactionsUpdated: 0,
    });
  }
  return _states.get(workspaceId)!;
}

function snapshot(
  ws: SyncState,
  currentName?: string,
  currentJid?: string,
  done?: boolean,
): PhotoStats {
  return {
    total: ws.total,
    processed: ws.processed,
    photosUpdated: ws.photosUpdated,
    unchanged: ws.unchanged,
    noPhoto: ws.noPhoto,
    skipped: ws.skipped,
    timeouts: ws.timeouts,
    errors: ws.errors,
    currentName,
    currentJid,
    done,
    durationMs: ws.startedAt
      ? (ws.finishedAt ?? new Date()).getTime() - ws.startedAt.getTime()
      : undefined,
    problematicJids: ws.problematicJids,
  };
}

// ─── Public control API ───────────────────────────────────────────────────────

/** True if a sync is already running for this workspace. */
export function isRunning(workspaceId: number): boolean {
  return getOrCreate(workspaceId).running;
}

/** Called by the route when the user presses "Omitir cliente". */
export function requestSkip(workspaceId: number): void {
  getOrCreate(workspaceId).skipRequested = true;
}

/** Called by the route when the user presses "Cancelar". */
export function requestAbort(workspaceId: number): void {
  getOrCreate(workspaceId).cancelRequested = true;
}

/** Set the current phase (called by the route between phases). */
export function setPhase(workspaceId: number, phase: 1 | 2): void {
  getOrCreate(workspaceId).phase = phase;
}

/** Store the interactions-updated count after phase 1 completes. */
export function setInteractionsUpdated(workspaceId: number, n: number): void {
  getOrCreate(workspaceId).interactionsUpdated = n;
}

/**
 * Returns a full status snapshot for the GET /crm-sync-status endpoint.
 * Safe to call at any time — returns running:false if no sync is active.
 */
export function getStatus(workspaceId: number) {
  const ws = getOrCreate(workspaceId);
  return {
    running: ws.running,
    phase: ws.phase,
    interactionsUpdated: ws.interactionsUpdated,
    startedAt: ws.startedAt?.toISOString() ?? null,
    ...snapshot(ws, ws.currentName, ws.currentJid, !ws.running && ws.finishedAt != null),
  };
}

/**
 * Fire-and-forget: attempt to fetch the WhatsApp profile photo for a newly
 * created or linked client.  Returns immediately — never throws.
 *
 * Only called from individual create/link flows (POST /clients,
 * PATCH /conversations/:id).  NOT called during mass sync, imports, or any
 * batch process — those use syncPhotos() directly.
 */
export function fetchPhotoForClientAsync(
  workspaceId: number,
  clientId: number,
  clientName: string,
  clientPhone: string | null,
): void {
  if (!clientPhone) return;

  // setImmediate schedules after the HTTP response is fully sent.
  setImmediate(async () => {
    try {
      // Optimization: skip if client already has a photo stored.
      const [row] = await db
        .select({ profilePicUrl: clientsTable.profilePicUrl })
        .from(clientsTable)
        .where(and(eq(clientsTable.id, clientId), eq(clientsTable.workspaceId, workspaceId)))
        .limit(1);

      if (row?.profilePicUrl) {
        logger.info({ workspaceId, clientId },
          `[AUTO PHOTO] Cliente: ${clientName} | Resultado: Ya tiene foto — omitido`);
        return;
      }

      const sock = getActiveSocket(workspaceId);
      if (!sock) {
        logger.info({ workspaceId, clientId },
          `[AUTO PHOTO] Cliente: ${clientName} | Resultado: Sin conexión WhatsApp activa`);
        return;
      }

      // 5 s timeout (mass sync uses 7 s; this is a lightweight single-client fetch).
      const clientRow: ClientRow = {
        id: clientId, workspaceId, name: clientName, phone: clientPhone, profilePicUrl: null,
      };
      const result = await fetchAndSavePhoto(clientRow, sock, 5_000);

      const label =
        result.status === "updated"  ? "Foto encontrada" :
        result.status === "no_photo" ? "Sin foto disponible" :
        result.status === "timeout"  ? "Timeout" : "Error WA";

      logger.info(
        { workspaceId, clientId, status: result.status, durationMs: result.durationMs },
        `[AUTO PHOTO] Cliente: ${clientName} | Resultado: ${label}`,
      );
    } catch (e: any) {
      logger.warn({ workspaceId, clientId, err: e?.message }, "[AUTO PHOTO] Error inesperado");
    }
  });
}

// Internal: consume skip flag (clears it; returns true if it was set).
function consumeSkip(ws: SyncState): boolean {
  if (!ws.skipRequested) return false;
  ws.skipRequested = false;
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toJid(phone: string): string {
  return `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Race a promise against a hard timeout.
 *
 * The timeout timer is CLEARED via clearTimeout() when the promise wins.
 * Without this, every successful call would leave a 7-second timer alive in
 * Node's event loop — 780 clients × 7 s = 91 minutes of orphan handles.
 *
 * Rejects with { timedOut: true } when the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`Timeout after ${ms}ms`), { timedOut: true })),
      ms,
    );
  });
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); return v; }),
    timeout,
  ]);
}

// ─── Phase 1: Interaction sync (bulk SQL) ─────────────────────────────────────

/**
 * Update lastContactAt for every client in one single SQL UPDATE.
 * Typical runtime < 500 ms regardless of client count.
 * Returns the number of rows updated.
 */
export async function syncInteractions(workspaceId: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE clients
    SET last_contact_at = subq.max_sent_at
    FROM (
      SELECT c.client_id, MAX(m.sent_at) AS max_sent_at
      FROM messages       m
      INNER JOIN conversations c ON m.conversation_id = c.id
      WHERE c.workspace_id = ${workspaceId}
      GROUP BY c.client_id
    ) subq
    WHERE clients.id            = subq.client_id
      AND clients.workspace_id  = ${workspaceId}
      AND (
        clients.last_contact_at IS NULL
        OR clients.last_contact_at < subq.max_sent_at
      )
  `);
  const updated = (result as any).rowCount ?? 0;
  logger.info({ workspaceId, updated }, "syncInteractions complete");
  return updated;
}

// ─── Phase 2: Photo sync ──────────────────────────────────────────────────────

interface ClientRow {
  id: number;
  workspaceId: number;
  name: string;
  phone: string;
  profilePicUrl: string | null;
}

/**
 * Fetch the WhatsApp profile photo for one client and persist the URL if it
 * changed.  Hard timeout (default 7 s for mass sync, 5 s for auto-fetch).
 * NEVER hangs longer than the timeout.  Only two DB writes on success.
 */
async function fetchAndSavePhoto(
  client: ClientRow,
  sock: any,
  timeoutMs = PHOTO_TIMEOUT_MS,
): Promise<{ status: PhotoStatus; reason?: string; durationMs: number }> {
  const jid = toJid(normalizePhone(client.phone));
  const t0 = Date.now();

  let url: string;
  try {
    url = await withTimeout(sock.profilePictureUrl(jid, "image"), timeoutMs);
  } catch (e: any) {
    const durationMs = Date.now() - t0;
    if (e?.timedOut) {
      return { status: "timeout", reason: `Timeout ${PHOTO_TIMEOUT_MS / 1000}s`, durationMs };
    }
    const reason: string = e?.message ?? String(e);
    const isNormal =
      reason.includes("404") ||
      reason.includes("403") ||
      reason.includes("not-authorized") ||
      reason.includes("item-not-found") ||
      reason.includes("forbidden");
    return { status: isNormal ? "no_photo" : "error", reason, durationMs };
  }

  const durationMs = Date.now() - t0;
  if (!url) return { status: "no_photo", reason: "empty url", durationMs };
  if (url === client.profilePicUrl) return { status: "unchanged", durationMs };

  try {
    await db
      .update(clientsTable)
      .set({ profilePicUrl: url })
      .where(and(eq(clientsTable.id, client.id), eq(clientsTable.workspaceId, client.workspaceId)));

    await db
      .update(conversationsTable)
      .set({ contactAvatar: url })
      .where(and(
        eq(conversationsTable.clientId, client.id),
        eq(conversationsTable.workspaceId, client.workspaceId),
      ));
  } catch (e: any) {
    return { status: "error", reason: `DB: ${e?.message ?? e}`, durationMs };
  }

  return { status: "updated", durationMs };
}

/**
 * Synchronous (awaitable) one-shot photo refresh for a single client.
 * Unlike fetchPhotoForClientAsync, this waits for the result and returns it.
 * Returns { status, profilePicUrl } — profilePicUrl is set only when status === "updated".
 */
export async function refreshPhotoForClient(
  workspaceId: number,
  clientId: number,
): Promise<{ status: PhotoStatus; profilePicUrl?: string }> {
  const [row] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.workspaceId, workspaceId)))
    .limit(1);

  if (!row || !row.phone) return { status: "no_photo" };

  const sock = getActiveSocket(workspaceId);
  if (!sock) return { status: "error" };

  const clientRow: ClientRow = {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    phone: row.phone,
    profilePicUrl: row.profilePicUrl ?? null,
  };

  // Allow 8 s for an on-demand fetch (user is actively waiting)
  const result = await fetchAndSavePhoto(clientRow, sock, 8_000);

  if (result.status === "updated") {
    // Re-read the URL we just saved
    const [updated] = await db
      .select({ profilePicUrl: clientsTable.profilePicUrl })
      .from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.workspaceId, workspaceId)))
      .limit(1);
    return { status: "updated", profilePicUrl: updated?.profilePicUrl ?? undefined };
  }

  return { status: result.status };
}

/**
 * Stream per-client photo sync for an entire workspace.
 *
 * Single linear flow:
 *   Init → for each client: check abort → announce → check skip → fetch → log → throttle → next
 *
 * Guarantees:
 * ✓ Only one instance runs per workspace at a time.
 * ✓ Every client is visited — 100% completion unless cancelled.
 * ✓ No client blocks longer than PHOTO_TIMEOUT_MS + TIMEOUT_COOLDOWN_MS.
 * ✓ Skip and abort take effect within ≤ 50 ms during the throttle window.
 * ✓ Structured per-client log for JID pattern analysis.
 */
export async function syncPhotos(
  workspaceId: number,
  onProgress: ProgressCallback,
): Promise<PhotoStats> {
  const ws = getOrCreate(workspaceId);

  // ── Acquire lock SYNCHRONOUSLY before any await ───────────────────────────
  // Setting ws.running = true here (before any DB call) makes the guard
  // atomic: a second call that arrives while we are awaiting the client list
  // will still see running=true and fail fast.  The route also checks
  // isRunning() as an early guard, but this is the authoritative lock.
  if (ws.running) {
    throw new Error("Ya existe una sincronización ejecutándose.");
  }
  ws.running = true;          // ← acquired; no await between check and set

  // Reset counters & control flags synchronously (before any await)
  ws.cancelRequested = false;
  ws.skipRequested = false;
  ws.total = 0;               // updated below once we have the client list
  ws.processed = 0;
  ws.photosUpdated = 0;
  ws.unchanged = 0;
  ws.noPhoto = 0;
  ws.skipped = 0;
  ws.timeouts = 0;
  ws.errors = 0;
  ws.startedAt = new Date();
  ws.finishedAt = null;
  ws.problematicJids = [];
  ws.phase = 2;
  ws.currentName = undefined;
  ws.currentJid = undefined;

  // try/finally wraps everything from here — even a DB failure must release the lock
  try {
    // Now safe to await — lock is already held
    const sock = getActiveSocket(workspaceId);
    const clients = await db
      .select({
        id: clientsTable.id,
        workspaceId: clientsTable.workspaceId,
        name: clientsTable.name,
        phone: clientsTable.phone,
        profilePicUrl: clientsTable.profilePicUrl,
      })
      .from(clientsTable)
      .where(eq(clientsTable.workspaceId, workspaceId))
      .orderBy(clientsTable.id);
    ws.total = clients.length;

    for (const client of clients) {

      // ── Abort check — exits the loop immediately ─────────────────────────
      if (ws.cancelRequested) {
        logger.info({ workspaceId, processed: ws.processed }, "[SYNC] Cancelled by user");
        break;
      }

      const jid = toJid(normalizePhone(client.phone));

      // Track current client in state so GET /crm-sync-status can return it.
      ws.currentName = client.name;
      ws.currentJid = jid;

      // Announce the client we are about to process BEFORE any async work.
      onProgress(snapshot(ws, client.name, jid));

      // ── Skip check (pre-fetch) ───────────────────────────────────────────
      if (consumeSkip(ws)) {
        ws.skipped++;
        ws.processed++;
        logger.debug(
          { name: client.name, jid },
          `[SYNC] ${client.name} | ${jid} | — skipped`,
        );
        onProgress(snapshot(ws, client.name, jid));
        continue;
      }

      // ── Photo fetch ──────────────────────────────────────────────────────
      if (sock) {
        const r = await fetchAndSavePhoto(client, sock);

        // Structured per-client log line (DEBUG level — enable for diagnosis)
        const resultLabel = r.status === "updated"   ? "✓ updated"
          : r.status === "unchanged" ? "— unchanged"
          : r.status === "no_photo"  ? "○ no_photo"
          : r.status === "timeout"   ? "⏱ timeout"
          : "✗ error";
        logger.debug(
          { name: client.name, jid, durationMs: r.durationMs, status: r.status, reason: r.reason },
          `[SYNC] ${client.name} | ${jid} | ${r.durationMs}ms | ${resultLabel}`,
        );

        if (r.status === "updated")   ws.photosUpdated++;
        else if (r.status === "unchanged") ws.unchanged++;
        else if (r.status === "no_photo")  ws.noPhoto++;
        else if (r.status === "timeout") { ws.timeouts++; ws.errors++; }
        else ws.errors++;

        // Accumulate problematic JIDs for pattern analysis
        if (r.status === "timeout" || r.status === "error") {
          ws.problematicJids.push({
            name: client.name,
            jid,
            reason: r.reason!,
            durationMs: r.durationMs,
          });
        }

        // Post-timeout cooldown — give Baileys time to drain the pending WA response
        if (r.status === "timeout") {
          await delay(TIMEOUT_COOLDOWN_MS);
        }
      } else {
        // No active WhatsApp socket — count as no_photo, keep moving
        ws.noPhoto++;
        logger.debug(
          { name: client.name, jid },
          `[SYNC] ${client.name} | ${jid} | — no socket`,
        );
      }

      ws.processed++;
      onProgress(snapshot(ws, client.name, jid));

      // ── Inter-client throttle (abort/skip aware) ─────────────────────────
      // Poll every 50 ms so skip/abort take effect within ≤ 50 ms.
      // If skip fires during throttle it just ends the wait early — the skip
      // counter is NOT incremented (throttle-time skip = "hurry up", not
      // "skip next client").
      if (sock) {
        for (let elapsed = 0; elapsed < THROTTLE_MS; elapsed += 50) {
          if (ws.cancelRequested) break;
          if (ws.skipRequested) { ws.skipRequested = false; break; }
          await delay(50);
        }
      }
    }
  } finally {
    ws.finishedAt = new Date();
    ws.running = false;
  }

  const durationMs = ws.finishedAt.getTime() - ws.startedAt!.getTime();
  const mins = Math.floor(durationMs / 60_000);
  const secs = Math.round((durationMs % 60_000) / 1000);
  const durationLabel = mins > 0 ? `${mins} min ${secs} s` : `${secs} s`;

  logger.info(
    {
      workspaceId,
      total: ws.total,
      photosUpdated: ws.photosUpdated,
      unchanged: ws.unchanged,
      noPhoto: ws.noPhoto,
      skipped: ws.skipped,
      timeouts: ws.timeouts,
      errors: ws.errors,
      durationMs,
      problematicCount: ws.problematicJids.length,
    },
    `[SYNC] Complete — ${ws.total} clients · ${ws.photosUpdated} updated · ${ws.unchanged} unchanged · ${ws.noPhoto} no_photo · ${ws.skipped} skipped · ${ws.timeouts} timeouts · ${ws.errors} errors · ${durationLabel}`,
  );

  return snapshot(ws, undefined, undefined, true);
}
