import "dotenv/config";
import http from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { loadState, shutdownWhatsApp } from "./services/whatsapp";
import { createSocketServer } from "./lib/socket";
import { startScheduler, stopScheduler } from "./services/schedulerService";
import { startCalendarSyncService, stopCalendarSyncService } from "./services/calendarSyncService";
import { startReminderService, stopReminderService } from "./services/reminderService";
import { startHintService, stopHintService } from "./services/hintService";
import { loadAllProviderConfigs } from "./services/aiProvider";

// ── Process-level crash safety ──────────────────────────────────────────────
// Without these, ANY unhandled promise rejection or thrown error anywhere in
// the process — a flaky WhatsApp/Baileys reconnect, a timing edge case in one
// of the background schedulers, an unexpected error shape from a third-party
// SDK — crashes the entire Node process. Every route (health included) then
// goes down until Render notices and restarts the instance, which shows up
// externally as exactly the intermittent 500/502 "works, then doesn't, then
// does again" pattern. Logging and continuing is deliberate: one bad
// background job or one bad request must not take down every other
// workspace's traffic. If a specific error turns out to leave the process in
// a genuinely unrecoverable state, the fix is narrower handling around that
// specific call, not letting the whole process die for every kind of error.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException — process continuing");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection — process continuing");
});


const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = http.createServer(app);
createSocketServer(httpServer);

httpServer.listen(port, async () => {
  logger.info({ port }, "Server listening");

  // Load AI provider configs into memory cache (all workspaces)
  try {
    await loadAllProviderConfigs();
  } catch (e) {
    logger.warn({ err: e }, "Could not load AI provider configs");
  }

  try {
    await loadState();
    logger.info("WhatsApp state loaded");
  } catch (e) {
    logger.warn({ err: e }, "Could not load WhatsApp state");
  }

  startScheduler();
  startCalendarSyncService();
  startReminderService();
  startHintService();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Redeploys (and autoscale instance recycling) send SIGTERM to the running
// process. Without this handler the WhatsApp socket kept trying to hold/
// reconnect its session after the process was told to exit, which could
// overlap with the new instance's socket and trigger a WhatsApp stream
// conflict — showing up as a connecting/disconnected loop after every
// republish. Closing the session socket promptly here lets the incoming
// instance take over cleanly.
let _shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info({ signal }, "Shutdown signal received — closing WhatsApp session and HTTP server");
  stopScheduler();
  stopCalendarSyncService();
  stopReminderService();
  stopHintService();
  try {
    await shutdownWhatsApp();
  } catch (e) {
    logger.warn({ err: e }, "Error during WhatsApp shutdown");
  }
  httpServer.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  // Safety net: force-exit if something keeps the event loop alive.
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
