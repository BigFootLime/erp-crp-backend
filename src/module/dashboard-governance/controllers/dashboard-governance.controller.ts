import type { Request, RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { isDemoMode } from "../../../config/demo-mode";
import {
  svcGetDashboardGovernance,
  svcGetDashboardUsageMetrics,
  svcRecordDashboardUsage,
} from "../services/dashboard-governance.service";
import {
  dashboardMetricsQuerySchema,
  dashboardUsageBodySchema,
} from "../validators/dashboard-governance.validators";

function getUser(req: Request) {
  if (!req.user || typeof req.user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return req.user;
}

export const getDashboardGovernance: RequestHandler = asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.set("Cache-Control", "no-store");
  // The presentation does not collect product telemetry or depend on feature
  // flag tables.  Its dashboard choice is intentionally deterministic.
  if (isDemoMode()) {
    res.json({
      schema_version: 1,
      default_experience: "ariane",
      rollback_experience: "v2",
      ariane_default_enabled: true,
      deep_links_preserved: true,
      telemetry: { enabled: false, collection: "daily_aggregate", retention_days: 30, identifiers_collected: false },
    });
    return;
  }
  res.json(await svcGetDashboardGovernance(user.id));
});

export const postDashboardUsage: RequestHandler = asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = dashboardUsageBodySchema.parse(req.body);
  const result = await svcRecordDashboardUsage({
    user_id: user.id,
    effective_role: user.role,
    input,
  });
  res.status(202).json(result);
});

export const getDashboardUsageMetrics: RequestHandler = asyncHandler(async (req, res) => {
  getUser(req);
  const query = dashboardMetricsQuerySchema.parse(req.query);
  res.json(await svcGetDashboardUsageMetrics(query));
});
