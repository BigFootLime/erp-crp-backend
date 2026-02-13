import type { Request } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

import type { AuditContext } from "../repository/production.repository";
import {
  createPointageManualSchema,
  listOperatorsQuerySchema,
  listPointagesQuerySchema,
  patchPointageSchema,
  pointageIdParamSchema,
  pointagesKpisQuerySchema,
  startPointageSchema,
  stopPointageSchema,
  validatePointageSchema,
} from "../validators/pointages.validators";
import {
  svcCreatePointageManual,
  svcGetPointage,
  svcListOperators,
  svcListPointages,
  svcPatchPointage,
  svcPointagesKpis,
  svcStartPointage,
  svcStopPointage,
  svcValidatePointage,
} from "../services/pointages.service";

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }

  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const ip = getClientIp(req);
  const device = parseDevice(userAgent);
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip,
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

export const listPointages = asyncHandler(async (req, res) => {
  const query = listPointagesQuerySchema.parse(req.query);
  const out = await svcListPointages(query);
  res.json(out);
});

export const getPointage = asyncHandler(async (req, res) => {
  const { id } = pointageIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetPointage(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createPointageManual = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const body = createPointageManualSchema.parse({ body: req.body }).body;
  const out = await svcCreatePointageManual({ body, audit });
  res.status(201).json(out);
});

export const startPointage = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = pointageIdParamSchema.parse({ params: req.params }).params;
  const body = startPointageSchema.parse({ body: req.body }).body;
  const out = await svcStartPointage({ id, body, audit });
  res.status(201).json(out);
});

export const stopPointage = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = pointageIdParamSchema.parse({ params: req.params }).params;
  const body = stopPointageSchema.parse({ body: req.body }).body;
  const out = await svcStopPointage({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const patchPointage = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = pointageIdParamSchema.parse({ params: req.params }).params;
  const body = patchPointageSchema.parse({ body: req.body }).body;
  const out = await svcPatchPointage({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const validatePointage = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = pointageIdParamSchema.parse({ params: req.params }).params;
  const body = validatePointageSchema.parse({ body: req.body }).body;
  const out = await svcValidatePointage({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const pointagesKpis = asyncHandler(async (req, res) => {
  const query = pointagesKpisQuerySchema.parse(req.query);
  const out = await svcPointagesKpis(query);
  res.json(out);
});

export const listOperators = asyncHandler(async (req, res) => {
  const query = listOperatorsQuerySchema.parse(req.query);
  const out = await svcListOperators(query);
  res.json(out);
});
