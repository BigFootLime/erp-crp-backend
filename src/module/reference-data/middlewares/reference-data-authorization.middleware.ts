import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  roleHasReferenceDataCapability,
  type ReferenceDataCapability,
} from "../domain/reference-data-policy";

export function requireReferenceDataCapability(capability: ReferenceDataCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    // This surface governs values that alter costs and operational promises.
    // Module access alone never grants the sensitive capability: the account's
    // effective role must explicitly carry it.
    if (!roleHasReferenceDataCapability(req.user.role, capability)) {
      next(new HttpError(403, "REFERENCE_DATA_CAPABILITY_REQUIRED", `Capacité de référence '${capability}' requise.`));
      return;
    }
    next();
  };
}
