import { logger } from "./logger";

/**
 * Resolves which origins are allowed to make credentialed cross-origin
 * requests to this API, entirely from environment variables — no code
 * change needed to add a new frontend deployment (Phase 14: localhost →
 * Render, Vercel → Render, must work purely via env vars).
 *
 * ALLOWED_ORIGINS: comma-separated list, e.g.
 *   ALLOWED_ORIGINS=http://localhost:5173,https://mi-app.vercel.app
 *
 * Always allows http(s)://localhost:* and http(s)://127.0.0.1:* in every
 * environment, including against the production backend — see
 * corsOriginCallback below for why that's safe.
 */
function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

const configuredOrigins = parseAllowedOrigins();

let warnedNoOrigins = false;

function isLocalhostOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * CORS "origin" callback for the `cors` package. Returns true/false rather
 * than echoing the origin string — the `cors` package itself takes care of
 * reflecting the exact Origin header back when this returns true, which is
 * what's required for credentialed requests (the wildcard "*" cannot be
 * combined with credentials per the CORS spec).
 */
export function corsOriginCallback(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // No Origin header — same-origin requests, curl, server-to-server, Render
  // health checks, etc. Always allow; there's no browser enforcing CORS here.
  if (!origin) return callback(null, true);

  // Always allowed, in every environment — including against the deployed
  // production backend. A browser can only ever send this Origin value when
  // the page is genuinely running on the developer's own machine; a remote
  // attacker's page cannot spoof it. This is what makes "run the frontend
  // locally against the production Render backend" work without having to
  // remember to add localhost to ALLOWED_ORIGINS.
  if (isLocalhostOrigin(origin)) return callback(null, true);

  if (configuredOrigins.length === 0) {
    // No allowlist configured at all. Fail open with a loud warning rather
    // than silently blocking every request in a fresh deployment that
    // hasn't set ALLOWED_ORIGINS yet — but this should be treated as a
    // "fix your config" signal, not a permanent production setup.
    if (!warnedNoOrigins) {
      warnedNoOrigins = true;
      logger.warn(
        "ALLOWED_ORIGINS is not set — allowing all origins. Set ALLOWED_ORIGINS " +
          "in production (comma-separated), e.g. https://my-app.vercel.app",
      );
    }
    return callback(null, true);
  }

  if (configuredOrigins.includes(origin)) return callback(null, true);

  logger.warn({ origin }, "Blocked request from origin not in ALLOWED_ORIGINS");
  return callback(null, false);
}
