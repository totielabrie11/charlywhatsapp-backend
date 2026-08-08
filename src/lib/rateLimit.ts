/**
 * Simple in-memory rate limiter (Fase 0.4)
 * Prevents a single IP from saturating expensive AI/document routes.
 *
 * Usage:
 *   router.post("/suggest", rateLimit({ max: 10, windowMs: 60_000 }), handler);
 */
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

interface Entry {
  count: number;
  resetAt: number;
}

// Global store — keyed by "IP:route"
const _store = new Map<string, Entry>();

// Periodically prune expired entries to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _store) {
    if (now > entry.resetAt) _store.delete(key);
  }
}, 60_000);

export interface RateLimitOptions {
  /** Max requests per window per IP */
  max: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Optional human-readable message (Spanish) */
  message?: string;
}

export function rateLimit({ max, windowMs, message }: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let entry = _store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      _store.set(key, entry);
    }

    entry.count++;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      logger.warn({ ip, path: req.path, count: entry.count }, "Rate limit exceeded");
      res.setHeader("Retry-After", retryAfter);
      res.status(429).json({
        error: message ?? `Demasiadas solicitudes. Intentá de nuevo en ${retryAfter} segundos.`,
      });
      return;
    }

    next();
  };
}
