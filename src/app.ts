import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { corsOriginCallback } from "./lib/corsOrigins";
import { notFoundHandler, errorHandler } from "./lib/errorHandler";

const app: Express = express();

// Render (and any proxy in front of this app) needs to see the real
// client-facing protocol/host for req.secure, the Clerk host-resolution
// below, and getClerkProxyHost() to work correctly behind a reverse proxy.
app.set("trust proxy", true);

// ── 1. CORS — the ABSOLUTE first middleware, before anything else,
// deliberately. Nothing may run before this that could throw, redirect, or
// otherwise short-circuit a response without CORS headers attached first —
// that includes helmet, compression, pino-http, and even the Clerk Frontend
// API proxy (which self-handles/streams its own response). Mounting cors()
// this early guarantees:
//   - EVERY OPTIONS preflight, to every path, is answered here directly by
//     the `cors` package (204 + ACAO/ACAM/ACAH) — it short-circuits and
//     never calls next() for OPTIONS unless preflightContinue is set, which
//     it isn't. Clerk, requireWorkspace, and every route are structurally
//     unreachable for a preflight request.
//   - No middleware — Clerk included — can ever respond 401 "before CORS",
//     because CORS has already run and already set headers on the response
//     object by the time anything downstream executes.
//   - Even the raw-streaming Clerk proxy below keeps these headers: Node's
//     ServerResponse merges headers set via res.setHeader() (done here by
//     `cors`) with whatever the proxy later passes to res.writeHead(),
//     preferring the proxy's only on an exact name collision — and the
//     proxy never sets Access-Control-Allow-* itself.
//
// Origin allowlist is entirely env-var driven (ALLOWED_ORIGINS) — see
// lib/corsOrigins.ts. localhost/127.0.0.1 (any port, so localhost:5173 is
// always covered) are allowed automatically outside production; Vercel (or
// any other) origin must be added to ALLOWED_ORIGINS in production. ────────
app.use(
  cors({
    origin: corsOriginCallback,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
    optionsSuccessStatus: 204,
  }),
);

// ── 2. Request logging. ─────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── 3. Security headers. crossOriginResourcePolicy is relaxed to
// "cross-origin" — helmet's default ("same-origin") would make browsers
// block the frontend (Vercel) from directly loading media/document URLs
// served by this API (e.g. WhatsApp media previews, document downloads),
// which is legitimate cross-origin usage in this architecture, not a bug.
// contentSecurityPolicy is disabled: this is a JSON API with no
// server-rendered HTML pages of its own, so a CSP header here has no
// browser-enforcement target and only adds noise. ───────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  }),
);

// ── 4. Response compression. ────────────────────────────────────────────────
app.use(compression());

// ── 5. Clerk Frontend API proxy — must stay before body parsers (streams
// raw bytes through to Clerk's own API; parsing/consuming the body first
// would break the proxied request). See middlewares/clerkProxyMiddleware.ts
// for why this exists — it's inert (a no-op passthrough) unless
// NODE_ENV=production AND the frontend is actually configured to call
// VITE_CLERK_PROXY_URL; leave that env var unset on Vercel unless you
// specifically need a Clerk custom-domain proxy. Runs AFTER cors() above, so
// its responses keep the Access-Control-Allow-* headers already set. ───────
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// 10 MB: documentos PDF/Excel se envían como base64 (~1.37× del tamaño original)
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

// ── 6. Clerk — attaches req.auth for every request; does not itself block
// unauthenticated requests (that's requireWorkspace, applied per-route in
// routes/index.ts, after the public health/calendar-callback routes).
// Structurally cannot run on an OPTIONS preflight — cors() above already
// terminated those before this line. Resolves the publishable key from the
// incoming request host so the same server can serve multiple Clerk custom
// domains; falls back to CLERK_PUBLISHABLE_KEY otherwise. ──────────────────
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// ── 7. Routes. ───────────────────────────────────────────────────────────────
app.use("/api", router);

// ── 8. 404 + centralized error handler — must be last. errorHandler is
// recognized as an error middleware by Express purely because it declares 4
// parameters; do not remove any of them even if unused. Runs after cors()
// too, so even error/404 JSON responses keep the CORS headers. ────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
