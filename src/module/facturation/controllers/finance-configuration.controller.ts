import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import {
  svcActivateFinanceConfiguration,
  svcCreateFinanceSequences,
  svcGetFinanceConfigurationReadiness,
} from "../services/finance-configuration.service";
import {
  activateFinanceConfigurationBodySchema,
  createFinanceSequencesBodySchema,
  financeConfigurationReadinessQuerySchema,
} from "../validators/finance-configuration.validators";

function actorFromRequest(req: Request): FinanceActorContext {
  const userId = req.user?.id;
  if (!Number.isInteger(userId) || !userId || userId <= 0) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return { userId, requestId: req.requestId ?? "missing-request-id", path: req.originalUrl.split("?")[0] ?? req.path };
}

export const getFinanceConfigurationReadiness: RequestHandler = async (req, res, next) => {
  try {
    actorFromRequest(req);
    res.json(await svcGetFinanceConfigurationReadiness(financeConfigurationReadinessQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
};

export const activateFinanceConfiguration: RequestHandler = async (req, res, next) => {
  try {
    const input = activateFinanceConfigurationBodySchema.parse(req.body);
    res.status(201).json(await svcActivateFinanceConfiguration({ input, actor: actorFromRequest(req) }));
  } catch (error) { next(error); }
};

export const createFinanceSequences: RequestHandler = async (req, res, next) => {
  try {
    const input = createFinanceSequencesBodySchema.parse(req.body);
    res.status(201).json(await svcCreateFinanceSequences({ input, actor: actorFromRequest(req) }));
  } catch (error) { next(error); }
};
