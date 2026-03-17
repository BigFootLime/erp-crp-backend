import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../controllers/notifications.controller";

const router = Router();

router.use(authenticateToken);

router.get("/", listNotifications);
router.post("/read-all", markAllNotificationsRead);
router.post("/:id/read", markNotificationRead);

export default router;
