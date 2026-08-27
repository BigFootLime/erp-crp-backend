import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcElectronicInvoiceReadiness,
  svcActivateSuperPdp,
  svcDeactivateSuperPdp,
  svcGetElectronicInvoice,
  svcGetElectronicCreditNote,
  svcGetSuperPdpConfiguration,
  svcHandleElectronicInvoiceWebhook,
  svcQueueElectronicInvoice,
  svcQueueElectronicCreditNote,
  svcReconcileElectronicInvoice,
  svcReconcileElectronicCreditNote,
} from "./electronic-invoice.service";
import {
  electronicInvoiceIdParamsSchema,
  electronicInvoiceProviderParamsSchema,
  activateSuperPdpBodySchema,
  deactivateSuperPdpBodySchema,
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

export const getSuperPdpConfiguration: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await svcGetSuperPdpConfiguration());
  } catch (error) {
    next(error);
  }
};

export const activateSuperPdp: RequestHandler = async (req, res, next) => {
  try {
    const input = activateSuperPdpBodySchema.parse(req.body);
    const result = await svcActivateSuperPdp({
      formats: input.formats,
      qualificationReference: input.qualification_reference,
      actor: actorFromRequest(req),
      idempotencyKey: idempotencyKey(req),
    });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
};

export const deactivateSuperPdp: RequestHandler = async (req, res, next) => {
  try {
    const input = deactivateSuperPdpBodySchema.parse(req.body);
    res.json(await svcDeactivateSuperPdp({ reason: input.reason, actor: actorFromRequest(req) }));
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

export const getElectronicCreditNote: RequestHandler = async (req, res, next) => {
  try {
    const { id } = electronicInvoiceIdParamsSchema.parse(req.params);
    res.json(await svcGetElectronicCreditNote(id));
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

export const queueElectronicCreditNote: RequestHandler = async (req, res, next) => {
  try {
    const { id } = electronicInvoiceIdParamsSchema.parse(req.params);
    const input = queueElectronicInvoiceBodySchema.parse(req.body);
    const result = await svcQueueElectronicCreditNote({
      creditNoteId: id,
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

export const reconcileElectronicCreditNote: RequestHandler = async (req, res, next) => {
  try {
    const { id } = electronicInvoiceIdParamsSchema.parse(req.params);
    res.json(await svcReconcileElectronicCreditNote({
      creditNoteId: id,
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
