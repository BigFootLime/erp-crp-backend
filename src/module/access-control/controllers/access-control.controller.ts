// src/module/access-control/controllers/access-control.controller.ts
import type { Request, RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import * as service from "../services/access-control.service";
import * as reviewService from "../services/access-review.service";
import type { AccessAuditContext } from "../types/access-control.types";
import {
  listAccessEventsQuerySchema,
  accessReviewIdSchema,
  createAccessReviewSchema,
  decideAccessReviewItemSchema,
  listAccessReviewsQuerySchema,
  setModuleDefaultSchema,
  setUserModuleAccessSchema,
  setUserModulesBulkSchema,
  unlockAllSchema,
} from "../validators/access-control.validators";

export function buildAuditContext(req: Request): AccessAuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;
  return {
    user_id: user.id,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    client_session_id: clientSessionId,
  };
}

// GET /auth/access-profile — accessible à TOUT compte authentifié : un opérateur
// doit pouvoir charger sa propre navigation sans être administrateur.
export const getAccessProfile: RequestHandler = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  res.json(await service.getAccessProfile(user.id));
});

export const getOverview: RequestHandler = asyncHandler(async (_req, res) => {
  res.json(await service.buildOverview());
});

export const putModuleDefault: RequestHandler = asyncHandler(async (req, res) => {
  const dto = setModuleDefaultSchema.parse({ params: req.params, body: req.body });
  const overview = await service.setModuleDefault({
    moduleKey: dto.params.moduleKey,
    enabled: dto.body.enabled_by_default,
    audit: buildAuditContext(req),
  });
  res.json(overview);
});

export const putUserModuleAccess: RequestHandler = asyncHandler(async (req, res) => {
  const dto = setUserModuleAccessSchema.parse({ params: req.params, body: req.body });
  const overview = await service.setUserModuleAccess({
    userId: Number(dto.params.userId),
    moduleKey: dto.params.moduleKey,
    decision: dto.body.access,
    audit: buildAuditContext(req),
  });
  res.json(overview);
});

export const putUserModulesBulk: RequestHandler = asyncHandler(async (req, res) => {
  const dto = setUserModulesBulkSchema.parse({ params: req.params, body: req.body });
  const overview = await service.setUserModulesBulk({
    userId: Number(dto.params.userId),
    entries: dto.body.entries,
    audit: buildAuditContext(req),
  });
  res.json(overview);
});

export const postUnlockAll: RequestHandler = asyncHandler(async (req, res) => {
  const dto = unlockAllSchema.parse({ body: req.body });
  const overview = await service.unlockAll({
    confirm: dto.body.confirm,
    audit: buildAuditContext(req),
  });
  res.json(overview);
});

export const getAccessEvents: RequestHandler = asyncHandler(async (req, res) => {
  const query = listAccessEventsQuerySchema.parse(req.query);
  res.json(await service.listAccessEvents(query));
});

function rawIdempotencyKey(req: Request): string | undefined {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" ? raw : undefined;
}

export const getAccessReviews: RequestHandler = asyncHandler(async (req, res) => {
  const query = listAccessReviewsQuerySchema.parse(req.query);
  res.json(await reviewService.listAccessReviews(query.limit));
});

export const postAccessReview: RequestHandler = asyncHandler(async (req, res) => {
  const dto = createAccessReviewSchema.parse({ body: req.body });
  const result = await reviewService.createAccessReview({
    ...dto.body,
    raw_idempotency_key: rawIdempotencyKey(req),
    audit: buildAuditContext(req),
  });
  res.status(result.replayed ? 200 : 201).json(result);
});

export const getAccessReview: RequestHandler = asyncHandler(async (req, res) => {
  const { reviewId } = accessReviewIdSchema.parse(req.params);
  res.json(await reviewService.getAccessReview(reviewId));
});

export const putAccessReviewDecision: RequestHandler = asyncHandler(async (req, res) => {
  const dto = decideAccessReviewItemSchema.parse({ params: req.params, body: req.body });
  res.json(await reviewService.decideAccessReviewItem({
    review_id: dto.params.reviewId,
    user_id: Number(dto.params.userId),
    decision: dto.body.decision,
    rationale: dto.body.rationale,
    raw_idempotency_key: rawIdempotencyKey(req),
    audit: buildAuditContext(req),
  }));
});

export const postCloseAccessReview: RequestHandler = asyncHandler(async (req, res) => {
  const { reviewId } = accessReviewIdSchema.parse(req.params);
  res.json(await reviewService.closeAccessReview({ review_id: reviewId, audit: buildAuditContext(req) }));
});
