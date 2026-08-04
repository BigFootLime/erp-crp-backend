import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import type { MarginScopeType } from "../domain/margin-engine";
import type { MarginAuditContext } from "../repository/margin-engine.repository";
import {
  createMarginInputSchema,
  createRateVersionSchema,
  marginReadQuerySchema,
  marginScopeParamsSchema,
  marginSnapshotBodySchema,
  marginSnapshotListQuerySchema,
} from "../validators/margin-engine.validators";
import {
  svcCreateMarginInput,
  svcCreateMarginSnapshot,
  svcCreateRateVersion,
  svcExportMargin,
  svcGetMargin,
  svcListRateVersions,
  svcListMarginSnapshots,
} from "../services/margin-engine.service";

const SCOPE_MAP: Record<"devis-line" | "devis" | "affaire" | "of", MarginScopeType> = {
  "devis-line": "DEVIS_LINE",
  devis: "DEVIS",
  affaire: "AFFAIRE",
  of: "OF",
};

function actorId(req: Request): number {
  if (typeof req.user?.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return req.user.id;
}

function buildAuditContext(req: Request): MarginAuditContext {
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const rawSessionId = typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null;
  const clientSessionId = rawSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawSessionId)
    ? rawSessionId
    : null;
  return {
    user_id: actorId(req),
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: "margin-engine",
    client_session_id: clientSessionId,
  };
}

export const getMargin: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const query = marginReadQuerySchema.parse(req.query);
    res.json(await svcGetMargin(SCOPE_MAP[params.scopeType], params.scopeRef, query.as_of));
  } catch (error) { next(error); }
};

export const exportMargin: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const query = marginReadQuerySchema.parse(req.query);
    const csv = await svcExportMargin(SCOPE_MAP[params.scopeType], params.scopeRef, query.as_of);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="margin-${params.scopeType}-${params.scopeRef}.csv"`);
    res.send(csv);
  } catch (error) { next(error); }
};

export const createMarginInput: RequestHandler = async (req, res, next) => {
  try {
    const input = createMarginInputSchema.parse(req.body);
    const created = await svcCreateMarginInput(input, buildAuditContext(req));
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const createRateVersion: RequestHandler = async (req, res, next) => {
  try {
    const input = createRateVersionSchema.parse(req.body);
    const created = await svcCreateRateVersion(input, buildAuditContext(req));
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const listRateVersions: RequestHandler = async (req, res, next) => {
  try {
    const query = marginReadQuerySchema.parse(req.query);
    res.json({ items: await svcListRateVersions(query.as_of) });
  } catch (error) { next(error); }
};

export const createMarginSnapshot: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const body = marginSnapshotBodySchema.parse(req.body);
    const query = marginReadQuerySchema.parse(req.query);
    const created = await svcCreateMarginSnapshot(
      SCOPE_MAP[params.scopeType], params.scopeRef, body.basis, query.as_of, buildAuditContext(req),
    );
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const listMarginSnapshots: RequestHandler = async (req, res, next) => {
  try {
    const params = marginScopeParamsSchema.parse(req.params);
    const query = marginSnapshotListQuerySchema.parse(req.query);
    const items = await svcListMarginSnapshots(SCOPE_MAP[params.scopeType], params.scopeRef, query);
    res.json({ items });
  } catch (error) { next(error); }
};
