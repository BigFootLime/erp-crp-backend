import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcCreateAvoirDraftWorkflow,
  svcIssueAvoirWorkflow,
  svcListAvoirEligibleLines,
  svcPreviewAvoir,
  svcRequestAvoirValidation,
  svcValidateAvoirWorkflow,
} from "../services/avoir-workflow.service";
import {
  avoirPreviewBodySchema,
  createAvoirDraftBodySchema,
  financeLegacyIdParamsSchema,
  validationDecisionBodySchema,
  workflowConfirmationBodySchema,
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

export const previewAvoirWorkflow: RequestHandler = async (req, res, next) => {
  try {
    actor(req);
    res.json(await svcPreviewAvoir(avoirPreviewBodySchema.parse(req.body)));
  } catch (error) {
    next(error);
  }
};

export const listAvoirEligibleLines: RequestHandler = async (req, res, next) => {
  try {
    actor(req);
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    res.json(await svcListAvoirEligibleLines(id));
  } catch (error) {
    next(error);
  }
};

export const createAvoirDraftWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const result = await svcCreateAvoirDraftWorkflow({
      input: createAvoirDraftBodySchema.parse(req.body),
      actor: actor(req),
      idempotencyKey: key(req),
    });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
};

export const requestAvoirValidationWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    res.json(
      await svcRequestAvoirValidation({
        avoirId: id,
        input: workflowConfirmationBodySchema.parse(req.body),
        actor: actor(req),
        idempotencyKey: key(req),
      })
    );
  } catch (error) {
    next(error);
  }
};

export const validateAvoirWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    res.json(
      await svcValidateAvoirWorkflow({
        avoirId: id,
        input: validationDecisionBodySchema.parse(req.body),
        actor: actor(req),
        idempotencyKey: key(req),
      })
    );
  } catch (error) {
    next(error);
  }
};

export const issueAvoirWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    res.json(
      await svcIssueAvoirWorkflow({
        avoirId: id,
        input: workflowConfirmationBodySchema.parse(req.body),
        actor: actor(req),
        idempotencyKey: key(req),
      })
    );
  } catch (error) {
    next(error);
  }
};
