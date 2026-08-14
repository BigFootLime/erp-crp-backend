import { Router } from "express";

import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  getWebhookDeliveries,
  getWebhookEvents,
  getWebhookReadiness,
  getWebhookSubscriptionById,
  getWebhookSubscriptions,
  patchWebhookSubscriptionController,
  postWebhookReplay,
  postWebhookSecretRotation,
  postWebhookSubscription,
  postWebhookTest,
} from "./webhook.controller";

const router = Router();

router.use(authenticateToken);
router.use(requireSuperadmin);

router.get("/readiness", getWebhookReadiness);
router.get("/events", getWebhookEvents);
router.get("/subscriptions", getWebhookSubscriptions);
router.get("/subscriptions/:id", getWebhookSubscriptionById);
router.post("/subscriptions", postWebhookSubscription);
router.patch("/subscriptions/:id", patchWebhookSubscriptionController);
router.post("/subscriptions/:id/rotate-secret", postWebhookSecretRotation);
router.post("/subscriptions/:id/test", postWebhookTest);
router.get("/deliveries", getWebhookDeliveries);
router.post("/deliveries/:id/replay", postWebhookReplay);

export default router;
