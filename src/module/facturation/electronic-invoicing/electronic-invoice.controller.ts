import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcElectronicInvoiceReadiness,
  svcGetElectronicInvoice,
  svcHandleElectronicInvoiceWebhook,
  svcQueueElectronicInvoice,
  svcReconcileElectronicInvoice,
} from "./electronic-invoice.service";
import {
  electronicInvoiceIdParamsSchema,
  electronicInvoiceProviderParamsSchema,
  queueElectronicInvoiceBodySchema,
} from "./electronic-invoice.validators";

function actorFromRequest(req: Request): FinanceActorContext {
  const userId = req.user?.id;
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return {
    userId,
    requestId: req.requestId ?? "missing-request-id",
    path: req.originalUrl.split("?")[0] ?? req.path,
  };
}

function idempotencyKey(req: Request): string | undefined {
  const value = req.headers["idempotency-key"];
  return typeof value === "string" ? value : undefined;
}

export const getElectronicInvoiceReadiness: RequestHandler = async (_req, res, next) => {
  try {
    const result = await svcElectronicInvoiceReadiness();
    res.status(result.ready ? 200 : 503).json(result);
  } catch (error) {
    next(error);
  }
};

export const getElectronicInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = electronicInvoiceIdParamsSchema.parse(req.params);
    res.json(await svcGetElectronicInvoice(id));
  } catch (error) {
    next(error);
  }
};

export const queueElectronicInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = electronicInvoiceIdParamsSchema.parse(req.params);
    const input = queueElectronicInvoiceBodySchema.parse(req.body);
    const result = await svcQueueElectronicInvoice({
      invoiceId: id,
      format: input.format,
      actor: actorFromRequest(req),
      idempotencyKey: idempotencyKey(req),
    });
    res.status(result.idempotent_replay ? 200 : 202).json(result);
  } catch (error) {
    next(error);
  }
};

export const reconcileElectronicInvoice: RequestHandler = async (req, res, next) => {
  try {
    const { id } = electronicInvoiceIdParamsSchema.parse(req.params);
    res.json(await svcReconcileElectronicInvoice({
      invoiceId: id,
      correlationId: req.correlationId ?? req.requestId ?? "missing-correlation-id",
      requestId: req.requestId ?? "missing-request-id",
      actor: actorFromRequest(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const receiveElectronicInvoiceWebhook: RequestHandler = async (req, res, next) => {
  try {
    const { providerCode } = electronicInvoiceProviderParamsSchema.parse(req.params);
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      throw new HttpError(400, "EINVOICE_WEBHOOK_RAW_BODY_REQUIRED", "Le corps brut signé du webhook est absent.");
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value.join(",") : value,
      ])
    );
    const result = await svcHandleElectronicInvoiceWebhook({
      providerCode,
      body: req.rawBody,
      headers,
      correlationId: req.correlationId ?? req.requestId ?? "missing-correlation-id",
      requestId: req.requestId ?? "missing-request-id",
    });
    res.status(result.replay ? 200 : 202).json(result);
  } catch (error) {
    next(error);
  }
};
