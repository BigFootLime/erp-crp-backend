import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasElevatedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasPlanningCapability, type PlanningCapability } from "../domain/planning-rbac";

export function requirePlanningCapability(capability: PlanningCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentication required"));
      return;
    }
    if (!requestHasElevatedAccountModuleAccess(req) && !roleHasPlanningCapability(req.user.role, capability)) {
      next(new HttpError(403, "PLANNING_CAPABILITY_REQUIRED", `Planning capability '${capability}' is required`));
      return;
    }
    next();
  };
}
