import { Router, type IRouter } from "express";
import healthRouter from "./health";
import whatsappRouter from "./whatsapp";
import conversationsRouter from "./conversations";
import clientsRouter from "./clients";
import googleContactsRouter from "./googleContacts";
import tasksRouter from "./tasks";
import documentsRouter from "./documents";
import pipelineRouter from "./pipeline";
import dashboardRouter from "./dashboard";
import settingsRouter from "./settings";
import systemRouter from "./system";
import marketingRouter from "./marketing";
import segmentsRouter from "./segments";
import campaignSendRouter from "./campaignSend";
import campaignScheduleRouter from "./campaignSchedule";
import commercialEngineRouter from "./commercialEngine";
import calendarRouter, { calendarPublicRouter } from "./calendar";
import aiProviderRouter from "./aiProvider";
import mediaSignedRouter from "./mediaSigned";
import { requireWorkspace } from "../middlewares/workspaceAuth";

const router: IRouter = Router();

// Health check stays unauthenticated (used for uptime probes).
router.use(healthRouter);

// Google Calendar OAuth callback — must be registered BEFORE requireWorkspace
// because the redirect from Google does not carry a Clerk session cookie.
router.use(calendarPublicRouter);

// Signed, time-limited media links ("copiar enlace") — intentionally public;
// authorization is the signed token itself, not a Clerk session. See
// routes/mediaSigned.ts and lib/mediaSignedUrl.ts.
router.use(mediaSignedRouter);

// Every other route requires an authenticated Clerk session and is scoped
// to the caller's workspace via req.workspaceId (see workspaceAuth.ts).
router.use(requireWorkspace);

router.use(whatsappRouter);
router.use(conversationsRouter);
router.use(googleContactsRouter); // must come before clientsRouter — avoids /clients/:id swallowing static sub-paths
router.use(clientsRouter);
router.use(tasksRouter);
router.use(documentsRouter);
router.use(pipelineRouter);
router.use(dashboardRouter);
router.use(settingsRouter);
router.use(systemRouter);
router.use(marketingRouter);
router.use(segmentsRouter);
router.use(campaignSendRouter);
router.use(campaignScheduleRouter);
router.use(commercialEngineRouter);
router.use(calendarRouter);
router.use(aiProviderRouter);

export default router;
