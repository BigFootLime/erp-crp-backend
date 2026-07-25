import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { roleHasMetrologyCapability, type MetrologyCapability } from "../domain/metrology-policy";

/**
 * Garde de capacité Métrologie (#229). Refus par défaut : un utilisateur
 * authentifié n'obtient aucun droit implicite. Masquer un bouton côté UI n'est
 * jamais une autorisation ; cette garde est rejouée à chaque requête, et le
 * domaine la revérifie pour les règles qui dépendent de l'objet manipulé.
 */
export function requireMetrologyCapability(capability: MetrologyCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (!roleHasMetrologyCapability(req.user.role, capability)) {
      next(
        new HttpError(
          403,
          "METROLOGY_CAPABILITY_REQUIRED",
          `La capacité Métrologie '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}
