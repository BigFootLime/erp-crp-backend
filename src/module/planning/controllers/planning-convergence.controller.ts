import type { Request, RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import {
  svcGetPlanningConvergence,
  svcGetPlanningUsageMetrics,
  svcRecordPlanningUsage,
} from "../services/planning-convergence.service";
import {
  planningUsageBodySchema,
  planningUsageMetricsQuerySchema,
} from "../validators/planning-convergence.validators";

function getUser(req: Request) {
  if (!req.user || typeof req.user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return req.user;
}

export const getPlanningConvergence: RequestHandler = asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.set("Cache-Control", "no-store");
  res.json(await svcGetPlanningConvergence(user.id));
});

export const postPlanningUsage: RequestHandler = asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = planningUsageBodySchema.parse(req.body);
  const result = await svcRecordPlanningUsage({
    user_id: user.id,
    effective_role: user.role,
    input,
  });
  res.status(202).json(result);
});

export const getPlanningUsageMetrics: RequestHandler = asyncHandler(async (req, res) => {
  getUser(req);
  const query = planningUsageMetricsQuerySchema.parse(req.query);
  res.json(await svcGetPlanningUsageMetrics(query));
});
