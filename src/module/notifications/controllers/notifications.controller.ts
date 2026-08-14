import type { Request } from "express";
import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import {
  escalateNotificationSchema,
  listNotificationsQuerySchema,
  muteNotificationSchema,
  notificationIdParamSchema,
} from "../validators/notifications.validators";
import {
  svcListAppNotifications,
  svcMarkAllAppNotificationsRead,
  svcMarkAppNotificationRead,
  svcEscalateAppNotification,
  svcMuteAppNotification,
} from "../services/notifications.service";

function getUserId(req: Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return userId;
}

function auditContext(req: Request) {
  const userId = getUserId(req);
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  return {
    user_id: userId,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    client_session_id:
      typeof req.headers["x-client-session-id"] === "string"
        ? req.headers["x-client-session-id"]
        : typeof req.headers["x-session-id"] === "string"
          ? req.headers["x-session-id"]
          : null,
  };
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

export const muteNotification: RequestHandler = asyncHandler(async (req, res) => {
  const dto = muteNotificationSchema.parse({ params: req.params, body: req.body });
  res.json(await svcMuteAppNotification({
    user_id: getUserId(req),
    notification_id: dto.params.id,
    muted_until: dto.body.muted_until,
    audit: auditContext(req),
  }));
});

export const escalateNotification: RequestHandler = asyncHandler(async (req, res) => {
  const dto = escalateNotificationSchema.parse({ params: req.params, body: req.body });
  res.json(await svcEscalateAppNotification({
    user_id: getUserId(req),
    notification_id: dto.params.id,
    level: dto.body.level,
    audit: auditContext(req),
  }));
});
