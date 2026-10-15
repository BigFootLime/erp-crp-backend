import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import * as service from "../services/audit-logs.service";
import { createAuditLogBodySchema, listAuditLogsQuerySchema } from "../validators/audit-logs.validators";
import { clientAuditEvent } from "../domain/client-audit";

export const createAuditLog: RequestHandler = async (req, res, next) => {
  try {
    const userId = typeof req.user?.id === "number" ? req.user.id : null;
    if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

    const body = clientAuditEvent(createAuditLogBodySchema.parse(req.body));
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
    if (!req.sensitiveCapabilities?.includes("audit.read")) {
      throw new HttpError(403, "FORBIDDEN", "Une habilitation de lecture du journal est requise.");
    }
    const filters = listAuditLogsQuerySchema.parse(req.query);
    const out = await service.svcListAuditLogs(filters);
    const userAgent = req.get("User-Agent") ?? null;
    await service.svcCreateAuditLog({ user_id: user.id, ip: getClientIp(req), user_agent: userAgent, ...parseDevice(userAgent),
      body: { event_type: "ACTION", action: "AUDIT_LOG_READ", page_key: "administration", entity_type: "audit_log", entity_id: null, path: req.path,
        details: { scope: "global", page: filters.page, page_size: filters.pageSize, returned_rows: out.items.length } } });
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) {
    next(e);
  }
};
