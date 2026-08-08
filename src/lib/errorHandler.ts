import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Mounted after every route — turns an unmatched path into a consistent JSON 404. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Not found: ${req.method} ${req.originalUrl}`,
    code: "NOT_FOUND",
  });
}

/**
 * Centralized error-handling middleware — must be the LAST `app.use()` call,
 * after every router (Express recognizes it as an error handler by its
 * 4-argument signature). Express 5 automatically forwards rejected promises
 * from async route handlers here, so this catches both sync throws and
 * async rejections from every route without each one needing its own
 * try/catch-and-format boilerplate.
 *
 * Always responds with { success: false, error, code } JSON — never an HTML
 * error page (Express's default error handler) and never a bare 500 with no
 * body. The full error (with stack) is always logged server-side; only a
 * generic message is sent to the client for non-ApiError / 5xx errors in
 * production, so internals (query text, file paths, stack frames) never
 * leak to the caller.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // Per Express docs: when headers are already sent (e.g. a proxied/
    // streamed response like the Clerk proxy), delegate to Express's own
    // default handler instead of trying to send a second response.
    next(err);
    return;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const isApiError = err instanceof ApiError;

  const status = isApiError ? err.status : 500;
  const code = isApiError ? err.code : "INTERNAL_ERROR";

  // Full detail always goes to the logs (pino redacts Authorization/cookie
  // headers already — see lib/logger.ts), regardless of environment.
  logger.error(
    { err, method: req.method, url: req.originalUrl },
    "Unhandled error in request handler",
  );

  const message =
    isApiError
      ? err.message
      : isProduction
        ? "Internal server error"
        : err instanceof Error
          ? err.message
          : String(err);

  res.status(status).json({ success: false, error: message, code });
}
