import type { Request, RequestHandler } from "express";
import type { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import { resolveRequest } from "../../facturation/services/reporting-v2.service";
import { reportingFiltersSchema } from "../../facturation/validators/reporting-v2.validators";
import {
  repoAdvOrderChain,
  repoAdvOverview,
  repoCreateDeliveryBlock,
  repoCreateInvoiceDispute,
  repoCreatePaymentPromise,
  repoResolveDeliveryBlock,
  repoUpdateInvoiceDispute,
  repoUpdatePaymentPromise,
  type AdvActor,
} from "../repository/adv-reliability.repository";
import {
  advOverviewQuerySchema,
  caseParamsSchema,
  deliveryBlockBodySchema,
  deliveryParamsSchema,
  invoiceDisputeBodySchema,
  invoiceDisputeStatusBodySchema,
  invoiceParamsSchema,
  orderParamsSchema,
  paymentPromiseBodySchema,
  paymentPromiseStatusBodySchema,
  resolveCaseBodySchema,
} from "../validators/adv-reliability.validators";

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Demande invalide.", parsed.error.flatten());
  return parsed.data;
}

function actorFrom(req: Request): AdvActor {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const forwarded = req.headers["x-forwarded-for"];
  return {
    user_id: req.user.id,
    ip: typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() ?? null : req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
  };
}

function idempotencyKeyFrom(req: Request): string {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 120) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "L'en-tête Idempotency-Key (8 à 120 caractères) est obligatoire.");
  }
  return value.trim();
}

export const advOverview: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    const reportingRequest = resolveRequest(parse(reportingFiltersSchema, req.query));
    const query = parse(advOverviewQuerySchema, {
      ...req.query,
      from: reportingRequest.ctx.period.from,
      to: reportingRequest.ctx.period.to,
      as_of: reportingRequest.ctx.asOf,
      client_id: reportingRequest.ctx.clientId,
      currency: reportingRequest.ctx.currency,
      limit: reportingRequest.ctx.limit,
    });
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoAdvOverview(query));
  } catch (error) { next(error); }
};

export const advOrderChain: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoAdvOrderChain(parse(orderParamsSchema, req.params).id));
  } catch (error) { next(error); }
};

export const createDeliveryBlock: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(deliveryParamsSchema, req.params);
    res.status(201).json(await repoCreateDeliveryBlock({
      deliveryId: id, input: parse(deliveryBlockBodySchema, req.body), actor: actorFrom(req), idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) { next(error); }
};

export const resolveDeliveryBlock: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(caseParamsSchema, req.params);
    res.json(await repoResolveDeliveryBlock({ id, input: parse(resolveCaseBodySchema, req.body), actor: actorFrom(req), idempotencyKey: idempotencyKeyFrom(req) }));
  } catch (error) { next(error); }
};

export const createPaymentPromise: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(invoiceParamsSchema, req.params);
    res.status(201).json(await repoCreatePaymentPromise({ invoiceId: id, input: parse(paymentPromiseBodySchema, req.body), actor: actorFrom(req), idempotencyKey: idempotencyKeyFrom(req) }));
  } catch (error) { next(error); }
};

export const updatePaymentPromise: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(caseParamsSchema, req.params);
    res.json(await repoUpdatePaymentPromise({ id, input: parse(paymentPromiseStatusBodySchema, req.body), actor: actorFrom(req), idempotencyKey: idempotencyKeyFrom(req) }));
  } catch (error) { next(error); }
};

export const createInvoiceDispute: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(invoiceParamsSchema, req.params);
    res.status(201).json(await repoCreateInvoiceDispute({ invoiceId: id, input: parse(invoiceDisputeBodySchema, req.body), actor: actorFrom(req), idempotencyKey: idempotencyKeyFrom(req) }));
  } catch (error) { next(error); }
};

export const updateInvoiceDispute: RequestHandler = async (req, res, next) => {
  try {
    const { id } = parse(caseParamsSchema, req.params);
    res.json(await repoUpdateInvoiceDispute({ id, input: parse(invoiceDisputeStatusBodySchema, req.body), actor: actorFrom(req), idempotencyKey: idempotencyKeyFrom(req) }));
  } catch (error) { next(error); }
};
