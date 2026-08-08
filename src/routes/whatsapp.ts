import { Router } from "express";
import * as wa from "../services/whatsapp";

const router = Router();

router.get("/whatsapp/status", async (req, res) => {
  const workspaceId = req.workspaceId!;
  res.json(wa.getStatus(workspaceId));
});

router.post("/whatsapp/connect", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const status = await wa.connect(workspaceId, false);
  res.json(status);
});

/** Clears all session data and forces a fresh QR generation */
router.post("/whatsapp/reconnect", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const status = await wa.reconnect(workspaceId);
  res.json(status);
});

router.post("/whatsapp/disconnect", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const status = await wa.disconnect(workspaceId);
  res.json(status);
});

/**
 * Cancel an in-progress connection attempt (QR or pairing code).
 * Returns the app to "disconnected" state — identical to the initial screen.
 * Safe to call at any point; no-op if already disconnected/connected.
 */
router.post("/whatsapp/cancel", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const status = await wa.cancelConnection(workspaceId);
  res.json(status);
});

/**
 * Request a pairing code for phone-number-based device linking.
 * Body: { phoneNumber: string }  — digits only, with country code, no +
 * Returns: { code: string } on success, { error: string } on failure.
 *
 * This is the recommended flow when WhatsApp Passkeys blocks QR scanning.
 * User enters the returned code in: WhatsApp → Settings → Linked Devices → Link with phone number.
 */
router.post("/whatsapp/pair", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber) {
    res.status(400).json({ error: "Falta el campo phoneNumber" });
    return;
  }
  const result = await wa.requestPairingCode(workspaceId, phoneNumber);
  if ("error" in result) {
    res.status(422).json(result);
    return;
  }
  res.json(result);
});

router.patch("/whatsapp/auto-reply", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { autoReply, travelMode } = req.body as { autoReply?: boolean; travelMode?: boolean };
  const status = await wa.updateAutoReply(workspaceId, autoReply, travelMode);
  res.json(status);
});

router.get("/whatsapp/logs", async (req, res) => {
  const workspaceId = req.workspaceId!;
  res.json(wa.getEvents(workspaceId));
});

router.get("/whatsapp/connection-monitor", async (req, res) => {
  const workspaceId = req.workspaceId!;
  res.json(await wa.getConnectionMonitor(workspaceId));
});

export default router;
