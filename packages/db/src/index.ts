import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's connection pooler (and most managed Postgres providers)
  // requires TLS; `rejectUnauthorized: false` matches Supabase's documented
  // node-postgres setup (their certificate chain isn't in Node's default
  // trust store). Skipped only for an explicit local/non-TLS DATABASE_URL.
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? false
    : { rejectUnauthorized: false },
  // Keep well under Supabase's pooler connection cap (their pooled/
  // transaction-mode port, 6543, has a limited number of pooled slots
  // shared across every client connecting to the project).
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// node-postgres emits 'error' on the Pool whenever a background/idle client
// hits a connection error (e.g. the server — or Supabase's pooler — closes
// an idle connection, a network blip, PgBouncer recycling a slot). Per
// node-postgres's own docs, an unhandled Pool 'error' event becomes an
// uncaught exception and crashes the entire Node process — not just the one
// query. Without this handler, exactly this was very likely the cause of
// the reported "works, then 500s across every route, then comes back a bit
// later" pattern: Render restarting the whole process after each crash,
// while every other route (health, auth, everything) is down mid-restart.
pool.on("error", (err) => {
  // console.error (not the app's pino logger) — packages/db is a standalone
  // vendored package and shouldn't import from ../src/lib/logger, which
  // would create a dependency from this low-level package back up into the
  // application layer.
  console.error("[db] Unexpected error on idle Postgres client:", err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
