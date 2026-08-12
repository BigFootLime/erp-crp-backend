import type { Request, RequestHandler } from "express";
import type { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import { resolveRequest } from "../../facturation/services/reporting-v2.service";
import { reportingFiltersSchema } from "../../facturation/validators/reporting-v2.validators";
import { requireIdempotencyKey } from "../domain/commercial-reliability";
import {
  repoCancelOrder,
  repoCommercialOverview,
  repoDecideDiscountApproval,
  repoExpireDueQuotes,
  repoOrderTimeline,
  repoRecordQuoteLoss,
  repoRecordQuoteReminder,
  repoRequestDiscountApproval,
  type CommercialActor,
} from "../repository/commercial-reliability.repository";
import {
  cancelOrderBodySchema,
  commercialEntityIdParamsSchema,
  commercialOverviewQuerySchema,
  discountDecisionBodySchema,
  discountRequestBodySchema,
  expireDueQuotesBodySchema,
  quoteLossBodySchema,
  quoteReminderBodySchema,
} from "../validators/commercial-reliability.validators";

function actorFrom(req: Request): CommercialActor {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : null;
  return {
    user_id: req.user.id,
    role: req.user.role ?? null,
    ip: forwardedIp ?? req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id: typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : null,
  };
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Demande invalide.", parsed.error.flatten());
  }
  return parsed.data;
}

function idempotencyKeyFrom(req: Request): string {
  try {
    return requireIdempotencyKey(req.headers["idempotency-key"]);
  } catch {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "L'en-tête Idempotency-Key (8 à 120 caractères) est obligatoire.");
  }
}

export const commercialOverview: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    const reportingQuery = parse(reportingFiltersSchema, req.query);
    const resolved = resolveRequest(reportingQuery);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoCommercialOverview(parse(commercialOverviewQuerySchema, {
      from: resolved.ctx.period.from,
      to: resolved.ctx.period.to,
      as_of: resolved.ctx.asOf,
      client_id: resolved.ctx.clientId,
      currency: resolved.ctx.currency,
      commercial_id: resolved.ctx.commercialId,
      limit: resolved.ctx.limit,
    })));
  } catch (error) {
    next(error);
  }
};

export const commercialOrderTimeline: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    const { id } = parse(commercialEntityIdParamsSchema, req.params);
    const result = await repoOrderTimeline(id);
    if (!result) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable.");
    res.setHeader("Cache-Control", "no-store, private");
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const recordQuoteReminder: RequestHandler = async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { id } = parse(commercialEntityIdParamsSchema, req.params);
    res.status(201).json(await repoRecordQuoteReminder({
      devisId: id,
      input: parse(quoteReminderBodySchema, req.body),
      actor,
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const recordQuoteLoss: RequestHandler = async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { id } = parse(commercialEntityIdParamsSchema, req.params);
    res.json(await repoRecordQuoteLoss({
      devisId: id,
      input: parse(quoteLossBodySchema, req.body),
      actor,
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const requestDiscountApproval: RequestHandler = async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { id } = parse(commercialEntityIdParamsSchema, req.params);
    res.status(201).json(await repoRequestDiscountApproval({
      devisId: id,
      input: parse(discountRequestBodySchema, req.body),
      actor,
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const decideDiscountApproval: RequestHandler = async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { id } = parse(commercialEntityIdParamsSchema, req.params);
    res.json(await repoDecideDiscountApproval({
      devisId: id,
      input: parse(discountDecisionBodySchema, req.body),
      actor,
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const expireDueQuotes: RequestHandler = async (req, res, next) => {
  try {
    res.json(await repoExpireDueQuotes({
      input: parse(expireDueQuotesBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const cancelOrder: RequestHandler = async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { id } = parse(commercialEntityIdParamsSchema, req.params);
    res.json(await repoCancelOrder({
      commandeId: id,
      input: parse(cancelOrderBodySchema, req.body),
      actor,
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};
