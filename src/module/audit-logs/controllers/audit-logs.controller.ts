import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import * as service from "../services/audit-logs.service";
import { createAuditLogBodySchema, listAuditLogsQuerySchema } from "../validators/audit-logs.validators";

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("admin") || r.includes("administrateur");
}

export const createAuditLog: RequestHandler = async (req, res, next) => {
  try {
    const userId = typeof req.user?.id === "number" ? req.user.id : null;
    if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

    const body = createAuditLogBodySchema.parse(req.body);
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
    const ip = getClientIp(req);
    const device = parseDevice(userAgent);

    const out = await service.svcCreateAuditLog({
      user_id: userId,
      body,
      ip,
      user_agent: userAgent,
      device_type: device.device_type,
      os: device.os,
      browser: device.browser,
    });

    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
};

export const listAuditLogs: RequestHandler = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user || typeof user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
    if (!isAdminRole(user.role)) throw new HttpError(403, "FORBIDDEN", "Admin role required");

    const filters = listAuditLogsQuerySchema.parse(req.query);
    const out = await service.svcListAuditLogs(filters);
    res.json(out);
  } catch (e) {
    next(e);
  }
};
