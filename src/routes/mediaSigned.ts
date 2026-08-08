import { Router, type IRouter } from "express";
import { rateLimit } from "../lib/rateLimit";
import { verifyMediaLinkToken } from "../lib/mediaSignedUrl";
import { findWorkspaceMessageMedia, sendMedia } from "./conversations";

const router: IRouter = Router();

// Deliberately NOT behind requireWorkspace / Clerk — this route's auth is
// the signed, time-limited token itself (see lib/mediaSignedUrl.ts). It
// exists specifically for links that need to work as a plain URL (pasted
// into a browser, "copiar enlace"), which cannot carry a Bearer
// Authorization header. Every other media access path in the app goes
// through the Clerk-authenticated /api/messages/:id/media route instead —
// see MediaPreviewModal.tsx on the frontend.
router.get("/media/signed/:token", rateLimit({ max: 60, windowMs: 60_000 }), async (req, res) => {
  const token = req.params.token as string;
  const payload = verifyMediaLinkToken(token);
  if (!payload) {
    res.status(401).json({ error: "Link inválido o expirado" });
    return;
  }

  const msg = await findWorkspaceMessageMedia(payload.messageId, payload.workspaceId);
  if (!msg || !msg.mediaData) {
    res.status(404).json({ error: "Media not found" });
    return;
  }

  sendMedia(res, msg, req.query.download === "1");
});

export default router;
