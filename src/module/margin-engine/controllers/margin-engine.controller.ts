import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { MarginScopeType } from "../domain/margin-engine";
import {
  createMarginInputSchema,
  createRateVersionSchema,
  marginReadQuerySchema,
  marginScopeParamsSchema,
  marginSnapshotBodySchema,
} from "../validators/margin-engine.validators";
import {
  svcCreateMarginInput,
  svcCreateMarginSnapshot,
  svcCreateRateVersion,
  svcExportMargin,
  svcGetMargin,
  svcListRateVersions,
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

async function auditMutation(req: Request, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  await repoInsertAuditLog({
    user_id: actorId(req),
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    body: {
      event_type: "ACTION",
      action,
      page_key: "margin-engine",
      entity_type: entityType,
      entity_id: entityId,
      path: req.originalUrl,
      client_session_id: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
      details,
    },
  });
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
    const created = await svcCreateMarginInput(input, actorId(req));
    await auditMutation(req, "MARGIN_INPUT_VERSION_CREATED", "margin_input_version", created.id, {
      scope_type: input.scope_type, scope_ref: input.scope_ref, basis: input.basis,
      input_key: input.input_key, supersedes_id: input.supersedes_id ?? null,
    });
    res.status(201).json(created);
  } catch (error) { next(error); }
};

export const createRateVersion: RequestHandler = async (req, res, next) => {
  try {
    const input = createRateVersionSchema.parse(req.body);
    const created = await svcCreateRateVersion(input, actorId(req));
    await auditMutation(req, "MARGIN_RATE_VERSION_CREATED", "margin_rate_version", created.id, {
      code: input.code, version: input.version, effective_from: input.effective_from,
      supersedes_id: input.supersedes_id ?? null, rate_count: input.rates.length,
    });
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
    const asOf = query.as_of ?? new Date().toISOString().slice(0, 10);
    const created = await svcCreateMarginSnapshot(SCOPE_MAP[params.scopeType], params.scopeRef, body.basis, asOf, actorId(req));
    await auditMutation(req, "MARGIN_RECALCULATION_SNAPSHOTTED", "margin_recalculation", created.id, {
      scope_type: SCOPE_MAP[params.scopeType], scope_ref: params.scopeRef, basis: body.basis, as_of: asOf,
    });
    res.status(201).json(created);
  } catch (error) { next(error); }
};
