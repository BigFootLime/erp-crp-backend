import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
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
    if (!roleHasFinanceCapability(req.user.role, capability)) {
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
