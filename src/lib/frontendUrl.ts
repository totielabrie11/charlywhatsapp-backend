/**
 * Single source of truth for "where does the frontend live" — used any time
 * the backend needs to send the user's BROWSER somewhere (a redirect after
 * an OAuth callback, a deep-link inside a Google Calendar event
 * description, etc.).
 *
 * This is deliberately a different variable from APP_URL (this backend's
 * OWN public URL, e.g. https://charlywhatsapp-backend.onrender.com — used
 * for things like the Google OAuth redirect_uri, which must point at THIS
 * server). Frontend and backend are two separate deployments (Vercel +
 * Render) on two different domains — conflating the two was the root cause
 * of `res.redirect("/calendar?...")` sending users to
 * https://charlywhatsapp-backend.onrender.com/calendar (a route that
 * doesn't exist on the backend) instead of the actual frontend.
 *
 * Set FRONTEND_URL in the environment:
 *   Local dev:   http://localhost:5173
 *   Production:  https://charlywhatsapp-frontend.vercel.app  (or your
 *                custom domain)
 *
 * No hardcoded fallback to any specific domain (Replit, Vercel, or
 * otherwise) — if it's not set, we fail loudly instead of silently sending
 * users to a URL that may not even belong to this deployment anymore.
 */
export function getFrontendUrl(): string {
  const url = process.env.FRONTEND_URL;
  if (!url) {
    throw new Error(
      "FRONTEND_URL environment variable is required but was not provided. " +
        "Set it to the frontend's public URL, e.g. https://charlywhatsapp-frontend.vercel.app",
    );
  }
  return url.replace(/\/$/, "");
}

/** Builds an absolute URL on the frontend for the given path (e.g. "/calendar?connected=1"). */
export function frontendUrl(path: string): string {
  return `${getFrontendUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
