import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcCreateEReportingPayment,
  svcCreateEReportingTransaction,
  svcListEReportingPeriods,
} from "./electronic-invoice-reporting.service";
import {
  eReportingPaymentBodySchema,
  eReportingPeriodsQuerySchema,
  eReportingTransactionBodySchema,
} from "./electronic-invoice-reporting.validators";

function actor(req: Request): FinanceActorContext {
  if (!req.user?.id) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { userId: req.user.id, requestId: req.requestId ?? "missing-request-id", path: req.originalUrl.split("?")[0] ?? req.path };
}

function key(req: Request): string {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string") throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key est obligatoire.");
  return value;
}

export const listEReportingPeriods: RequestHandler = async (req, res, next) => {
  try {
    actor(req);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await svcListEReportingPeriods(eReportingPeriodsQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
};

export const createEReportingTransaction: RequestHandler = async (req, res, next) => {
  try {
    const result = await svcCreateEReportingTransaction({ body: eReportingTransactionBodySchema.parse(req.body), actor: actor(req), idempotencyKey: key(req) });
    res.status(result.idempotent_replay ? 200 : 202).json(result);
  } catch (error) { next(error); }
};

export const createEReportingPayment: RequestHandler = async (req, res, next) => {
  try {
    const result = await svcCreateEReportingPayment({ body: eReportingPaymentBodySchema.parse(req.body), actor: actor(req), idempotencyKey: key(req) });
    res.status(result.idempotent_replay ? 200 : 202).json(result);
  } catch (error) { next(error); }
};
