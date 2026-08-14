import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  listNotifications,
  escalateNotification,
  markAllNotificationsRead,
  markNotificationRead,
  muteNotification,
} from "../controllers/notifications.controller";

const router = Router();

router.use(authenticateToken);

router.get("/", listNotifications);
router.post("/read-all", markAllNotificationsRead);
router.post("/:id/read", markNotificationRead);
router.post("/:id/mute", muteNotification);
router.post("/:id/escalate", escalateNotification);

export default router;
