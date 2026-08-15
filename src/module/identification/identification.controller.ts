import type { Request, RequestHandler } from "express";

import { HttpError } from "../../utils/httpError";
import {
  identificationCapabilities,
  invalidateLabel,
  issueLabel,
  listLabels,
  printLabel,
  replaceLabel,
  resolveIdentification,
  syncOfflineIdentification,
} from "./identification.service";
import {
  identificationUuidSchema,
  invalidateIdentificationLabelSchema,
  issueIdentificationLabelSchema,
  listIdentificationLabelsSchema,
  printIdentificationLabelSchema,
  replaceIdentificationLabelSchema,
  resolveIdentificationSchema,
  syncIdentificationOfflineSchema,
} from "./identification.validators";
import type { IdentificationActor } from "./identification.repository";

function actor(req: Request): IdentificationActor {
  const userId = req.user?.id;
  if (!Number.isSafeInteger(userId) || !userId || userId <= 0) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return {
    user_id: userId,
    role: typeof req.user?.role === "string" ? req.user.role : null,
    request_id: req.requestId ?? null,
    correlation_id: req.correlationId ?? null,
  };
}

function idempotencyKey(req: Request): string | undefined {
  return req.get("Idempotency-Key") ?? undefined;
}

function labelId(req: Request): string {
  return identificationUuidSchema.parse(req.params.labelId);
}

const scanStatus: Record<string, number> = {
  INVALID_PAYLOAD: 422,
  UNKNOWN: 404,
  INVALIDATED: 410,
  ENTITY_NOT_FOUND: 410,
  WRONG_ENTITY_TYPE: 422,
  FORBIDDEN_STATUS: 409,
  INSUFFICIENT_PERMISSION: 403,
  STALE_OFFLINE_EVENT: 409,
  FUTURE_TIMESTAMP: 409,
};

export const getIdentificationCapabilities: RequestHandler = async (req, res, next) => {
  try { res.setHeader("Cache-Control", "private, no-store"); res.json(await identificationCapabilities(actor(req))); } catch (error) { next(error); }
};

export const getIdentificationLabels: RequestHandler = async (req, res, next) => {
  try { res.setHeader("Cache-Control", "private, no-store"); res.json(await listLabels({ filters: listIdentificationLabelsSchema.parse(req.query), actor: actor(req) })); } catch (error) { next(error); }
};

export const createIdentificationLabel: RequestHandler = async (req, res, next) => {
  try {
    const result = await issueLabel({ body: issueIdentificationLabelSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (error) { next(error); }
};

export const printIdentificationLabel: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await printLabel({ labelId: labelId(req), body: printIdentificationLabelSchema.parse(req.body), actor: actor(req), idempotencyKey: idempotencyKey(req) }));
  } catch (error) { next(error); }
};

export const invalidateIdentificationLabel: RequestHandler = async (req, res, next) => {
  try {
    const body = invalidateIdentificationLabelSchema.parse(req.body);
    res.json(await invalidateLabel({ labelId: labelId(req), reason: body.reason, actor: actor(req), idempotencyKey: idempotencyKey(req) }));
  } catch (error) { next(error); }
};

export const replaceIdentificationLabel: RequestHandler = async (req, res, next) => {
  try {
    const body = replaceIdentificationLabelSchema.parse(req.body);
    res.json(await replaceLabel({ labelId: labelId(req), reason: body.reason, actor: actor(req), idempotencyKey: idempotencyKey(req) }));
  } catch (error) { next(error); }
};

export const resolveIdentificationCode: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    const result = await resolveIdentification(resolveIdentificationSchema.parse(req.body), actor(req));
    res.status(result.ok ? 200 : (scanStatus[result.result_code] ?? 422)).json(result);
  } catch (error) { next(error); }
};

export const syncOfflineIdentificationCodes: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    const body = syncIdentificationOfflineSchema.parse(req.body);
    res.json(await syncOfflineIdentification(body.events, actor(req)));
  } catch (error) { next(error); }
};
