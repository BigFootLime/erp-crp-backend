import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcAllocatePaymentWorkflow,
  svcRegisterPaymentWorkflow,
} from "../services/payment-workflow.service";
import {
  allocatePaymentBodySchema,
  financeLegacyIdParamsSchema,
  registerPaymentBodySchema,
} from "../validators/workflow.validators";

function actor(req: Request): FinanceActorContext {
  const userId = req.user?.id;
  if (typeof userId !== "number" || userId <= 0) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return {
    userId,
    requestId: req.requestId ?? "missing-request-id",
    path: req.originalUrl.split("?")[0] ?? req.path,
  };
}

function key(req: Request): string | undefined {
  const value = req.headers["idempotency-key"];
  return typeof value === "string" ? value : undefined;
}

export const registerPaymentWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const result = await svcRegisterPaymentWorkflow({
      input: registerPaymentBodySchema.parse(req.body),
      actor: actor(req),
      idempotencyKey: key(req),
    });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
};

export const allocatePaymentWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    res.json(
      await svcAllocatePaymentWorkflow({
        paymentId: id,
        input: allocatePaymentBodySchema.parse(req.body),
        actor: actor(req),
        idempotencyKey: key(req),
      })
    );
  } catch (error) {
    next(error);
  }
};
