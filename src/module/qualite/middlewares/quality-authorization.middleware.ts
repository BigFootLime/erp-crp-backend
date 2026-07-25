import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { roleHasQualityCapability, type QualityCapability } from "../domain/quality-policy";

/**
 * Garde de capacité Qualité (#228). Refus par défaut : un utilisateur
 * authentifié n'obtient aucun droit implicite. Masquer un bouton côté UI n'est
 * jamais une autorisation, cette garde est rejouée pour chaque requête.
 */
export function requireQualityCapability(capability: QualityCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (!roleHasQualityCapability(req.user.role, capability)) {
      next(
        new HttpError(
          403,
          "QUALITY_CAPABILITY_REQUIRED",
          `La capacité Qualité '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}
