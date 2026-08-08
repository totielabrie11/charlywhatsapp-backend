import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, HMAC-signed tokens for media URLs that must work as a plain
 * URL — not a `fetch()` call — because they're meant to be copied/shared or
 * opened directly by the browser (`<a href>`, "copy link"), which cannot
 * carry a Bearer Authorization header.
 *
 * This is deliberately scoped to ONE use case (the "copiar enlace" feature).
 * Everything else (viewing/downloading media already loaded in the app) is
 * fixed on the frontend by reusing the media bytes that arrived with the
 * already-authenticated conversation/message fetch, or by fetching with a
 * normal Authorization header and turning the response into a blob: URL —
 * see MediaPreviewModal.tsx. Neither of those needs a signed URL at all.
 */

const SECRET = process.env.MEDIA_LINK_SECRET ?? process.env.CLERK_SECRET_KEY ?? "";

if (!process.env.MEDIA_LINK_SECRET) {
  // Not fatal — falling back to CLERK_SECRET_KEY keeps this working without
  // extra required config, but a dedicated secret is better hygiene (rotating
  // it doesn't invalidate Clerk sessions, and it's not reused for anything
  // else). Recommended, not required.
  // eslint-disable-next-line no-console
  console.warn(
    "[media] MEDIA_LINK_SECRET is not set — falling back to CLERK_SECRET_KEY " +
      "to sign media links. Set MEDIA_LINK_SECRET explicitly in production.",
  );
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface MediaLinkPayload {
  messageId: number;
  workspaceId: number;
  exp: number; // epoch ms
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

/** Creates a signed, time-limited token for a single message's media. */
export function createMediaLinkToken(messageId: number, workspaceId: number, ttlMs = DEFAULT_TTL_MS): string {
  const payload: MediaLinkPayload = { messageId, workspaceId, exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Validates a token produced by createMediaLinkToken(). Returns the decoded
 * payload if valid and not expired, or null otherwise (bad signature,
 * malformed token, or expired) — never throws, so callers can always
 * respond with a clean 401/404 instead of a 500.
 */
export function verifyMediaLinkToken(token: string): MediaLinkPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  const expectedSig = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as MediaLinkPayload;
    if (typeof payload.messageId !== "number" || typeof payload.workspaceId !== "number" || typeof payload.exp !== "number") {
      return null;
    }
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
