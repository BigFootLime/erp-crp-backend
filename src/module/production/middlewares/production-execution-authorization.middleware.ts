import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import {
  roleHasProductionExecutionCapability,
  type ProductionExecutionCapability,
} from "../domain/production-execution";

/**
 * Garde de capacité du suivi de production (#274). Refus par défaut : être
 * authentifié n'accorde AUCUN droit implicite. La garde est rejouée à chaque
 * requête — masquer un bouton côté UI n'a jamais été une autorisation.
 */
export function requireProductionExecutionCapability(
  capability: ProductionExecutionCapability
): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasProductionExecutionCapability(req.user.role, capability)
    ) {
      next(
        new HttpError(
          403,
          "PRODUCTION_EXECUTION_CAPABILITY_REQUIRED",
          `La capacité de suivi de production '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}

/**
 * Toute commande à effet exige une clé d'idempotence. Sans elle, un double-clic
 * ou un retry réseau produirait deux effets — le contrat est donc explicite et
 * refusé en amont plutôt que deviné.
 */
export const requireIdempotencyKey: RequestHandler = (req, _res, next) => {
  const raw = req.headers["idempotency-key"];
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key.length < 8 || key.length > 200) {
    next(
      new HttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "L'en-tête Idempotency-Key est requis (8 à 200 caractères) pour cette action."
      )
    );
    return;
  }
  next();
};
