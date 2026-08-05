import type { Request, Response } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import type { AuditContext } from "../repository/production.repository";
import { svcSyncOfflineStation } from "../services/offline-station.service";
import { offlineStationSyncSchema } from "../validators/offline-station.validators";

export const syncOfflineStation = asyncHandler(async (req: Request, res: Response) => {
  if (!req.station) {
    throw new HttpError(401, "STATION_SESSION_REQUIRED", "Réauthentification de la station requise.");
  }
  const body = offlineStationSyncSchema.parse(req.body);
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const audit: AuditContext = {
    user_id: req.station.user.id,
    user_role: req.station.user.role,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: "atelier-offline-sync",
    client_session_id: req.station.session_id,
  };
  const result = await svcSyncOfflineStation({ body, station: req.station, audit });
  res.status(result.kill_switch_enabled ? 503 : 200).json(result);
});
