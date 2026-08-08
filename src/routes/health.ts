import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { getIO } from "../lib/socket";

const router: IRouter = Router();

// Legacy path — kept for backward compatibility with anything already
// pointed at it (e.g. an existing Render health check or uptime monitor).
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Public, unauthenticated health check. IMPORTANT: this must stay mounted
// here, before requireWorkspace in routes/index.ts — otherwise requests to
// this exact path (with no valid session) get a 401 from requireWorkspace
// instead of ever reaching this handler, which is what was happening when
// something (or Render's own health check) requested "/api/health": there
// was no route registered at that path at all, only "/api/healthz", so it
// fell through to the auth-protected catch-all below and came back
// "Unauthorized" — not because health was accidentally protected, but
// because it didn't exist under that name.
router.get("/health", async (_req, res) => {
  const startedAt = Date.now();

  // Each dependency check is isolated and never throws — a single degraded
  // dependency must not prevent the health check itself from responding.
  const database = await checkDatabase();
  const clerk = checkClerkConfigured();
  const socket = checkSocket();

  const allHealthy = database.status === "ok" && clerk.status === "ok";

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ok" : "degraded",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV ?? "development",
    version: process.env.npm_package_version ?? "0.0.0",
    checkDurationMs: Date.now() - startedAt,
    database,
    // "supabase" is an alias for the same Postgres check — kept as its own
    // key since that's the field name the audit/monitoring asked for, even
    // though under the hood it's the same @workspace/db pool (Supabase
    // Postgres in this deployment).
    supabase: database,
    clerk,
    socket,
  });
});

async function checkDatabase(): Promise<{ status: "ok" | "error"; error?: string }> {
  try {
    await pool.query("SELECT 1");
    return { status: "ok" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function checkClerkConfigured(): { status: "ok" | "error"; error?: string } {
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    return { status: "error", error: "Clerk keys not configured" };
  }
  return { status: "ok" };
}

function checkSocket(): { status: "ok" | "not_initialized"; connectedClients?: number } {
  const io = getIO();
  if (!io) return { status: "not_initialized" };
  return { status: "ok", connectedClients: io.engine?.clientsCount ?? 0 };
}

export default router;
