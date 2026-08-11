import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import {
  roleHasProductionReadinessCapability,
  type ProductionReadinessCapability,
} from "../domain/production-readiness-policy";

export function requireProductionReadinessCapability(capability: ProductionReadinessCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasProductionReadinessCapability(req.user.role, capability)
    ) {
      next(
        new HttpError(
          403,
          "PRODUCTION_READINESS_CAPABILITY_REQUIRED",
          `La capacité de préparation production '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}
