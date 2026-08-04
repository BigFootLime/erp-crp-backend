import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import {
  roleHasFinanceCapability,
  type FinanceCapability,
} from "../domain/finance-policy";

export function requireFinanceCapability(capability: FinanceCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasFinanceCapability(req.user.role, capability)
    ) {
      next(
        new HttpError(
          403,
          "FINANCE_CAPABILITY_REQUIRED",
          `La capacité Finance '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}

export function requireFinanceCapabilityWhen(
  capability: FinanceCapability,
  isRequired: (req: Request) => boolean
): RequestHandler {
  const requireCapability = requireFinanceCapability(capability);
  return (req, res, next) => {
    if (!isRequired(req)) {
      next();
      return;
    }
    requireCapability(req, res, next);
  };
}

export const requirePaymentAllocationCapabilityForInlineAllocations = requireFinanceCapabilityWhen(
  "payment_allocate",
  (req) => Array.isArray(req.body?.allocations) && req.body.allocations.length > 0
);
