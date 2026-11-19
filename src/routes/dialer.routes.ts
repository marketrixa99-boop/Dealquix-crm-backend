import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { authorize } from "../middleware/authorize.middleware.js";
import { trackActivity } from "../middleware/auditLogger.middleware.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { getLeadCallHistoryController, getCallLogs, getCallLogById, proxyRecordingAudio } from "../controllers/dialerController.js";
import { getSession, getSettings, updateSettings, getAgents, updateAgent, clickToCall } from "../controllers/dialixa.controller.js";

const router = Router();

// Retire the old provider's call initiation/webhooks; history stays read-only.
router.all(["/token", "/answer-url", "/events"], (_req, res) => {
  res.status(410).json({ success: false, message: "Stringee calling has been replaced by Dialixa.", code: "DIALER_REPLACED" });
});
router.get("/recording-proxy", proxyRecordingAudio);

router.use(authenticate);
router.get("/session", authorize(PERMISSIONS.CALL_INITIATE), getSession);
router.post("/click-to-call", authorize(PERMISSIONS.CALL_INITIATE), clickToCall);

router.get("/settings", authorize(PERMISSIONS.INTEGRATION_VIEW), getSettings);
router.put("/settings", authorize(PERMISSIONS.INTEGRATION_MANAGE),
  trackActivity("CALL_LOG", "DIALIXA_SETTINGS_UPDATED", () => "Updated Dialixa account settings"), updateSettings);
router.get("/agents", authorize(PERMISSIONS.DIALER_AGENT_VIEW), getAgents);
router.patch("/agents/:userId", authorize(PERMISSIONS.DIALER_AGENT_MANAGE),
  trackActivity("CALL_LOG", "DIALIXA_AGENT_UPDATED", (req) => `Updated Dialixa extension access for user ${req.params.userId}`), updateAgent);

router.get("/lead/:leadId", authorize(PERMISSIONS.CALL_LOG_VIEW), getLeadCallHistoryController);
router.get("/logs", authorize(PERMISSIONS.CALL_LOG_VIEW), getCallLogs);
router.get("/logs/:id", authorize(PERMISSIONS.CALL_LOG_VIEW), getCallLogById);

export default router;
