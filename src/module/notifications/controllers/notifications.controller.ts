import type { Request } from "express";
import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { notificationIdParamSchema, listNotificationsQuerySchema } from "../validators/notifications.validators";
import {
  svcListAppNotifications,
  svcMarkAllAppNotificationsRead,
  svcMarkAppNotificationRead,
} from "../services/notifications.service";

function getUserId(req: Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return userId;
}

export const listNotifications: RequestHandler = asyncHandler(async (req, res) => {
  const query = listNotificationsQuerySchema.parse(req.query);
  const out = await svcListAppNotifications({ user_id: getUserId(req), query });
  res.json(out);
});

export const markNotificationRead: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = notificationIdParamSchema.parse({ params: req.params }).params;
  const out = await svcMarkAppNotificationRead({ user_id: getUserId(req), notification_id: id });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const markAllNotificationsRead: RequestHandler = asyncHandler(async (req, res) => {
  const out = await svcMarkAllAppNotificationsRead({ user_id: getUserId(req) });
  res.json(out);
});
