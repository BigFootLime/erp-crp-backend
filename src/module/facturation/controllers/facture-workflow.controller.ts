import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcCreateFactureDraft,
  svcIssueFacture,
  svcListEligibleFactureSources,
  svcPreviewFacture,
  svcRequestFactureValidation,
  svcValidateFacture,
} from "../services/facture-workflow.service";
import {
  createFactureDraftBodySchema,
  eligibleSourcesQuerySchema,
  financeLegacyIdParamsSchema,
  facturePreviewBodySchema,
  validationDecisionBodySchema,
  workflowConfirmationBodySchema,
} from "../validators/workflow.validators";

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

export const listEligibleFactureSources: RequestHandler = async (req, res, next) => {
  try {
    actorFromRequest(req);
    const filters = eligibleSourcesQuerySchema.parse(req.query);
    res.json(await svcListEligibleFactureSources(filters));
  } catch (error) {
    next(error);
  }
};

export const previewFacture: RequestHandler = async (req, res, next) => {
  try {
    actorFromRequest(req);
    const input = facturePreviewBodySchema.parse(req.body);
    res.json(await svcPreviewFacture(input));
  } catch (error) {
    next(error);
  }
};

export const createFactureDraftWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const input = createFactureDraftBodySchema.parse(req.body);
    const result = await svcCreateFactureDraft({
      input,
      actor: actorFromRequest(req),
      idempotencyKey: idempotencyKey(req),
    });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
};

export const requestFactureValidation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    const input = workflowConfirmationBodySchema.parse(req.body);
    res.json(
      await svcRequestFactureValidation({
        factureId: id,
        input,
        actor: actorFromRequest(req),
        idempotencyKey: idempotencyKey(req),
      })
    );
  } catch (error) {
    next(error);
  }
};

export const validateFactureWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    const input = validationDecisionBodySchema.parse(req.body);
    res.json(
      await svcValidateFacture({
        factureId: id,
        input,
        actor: actorFromRequest(req),
        idempotencyKey: idempotencyKey(req),
      })
    );
  } catch (error) {
    next(error);
  }
};

export const issueFactureWorkflow: RequestHandler = async (req, res, next) => {
  try {
    const { id } = financeLegacyIdParamsSchema.parse(req.params);
    const input = workflowConfirmationBodySchema.parse(req.body);
    res.json(
      await svcIssueFacture({
        factureId: id,
        input,
        actor: actorFromRequest(req),
        idempotencyKey: idempotencyKey(req),
      })
    );
  } catch (error) {
    next(error);
  }
};
