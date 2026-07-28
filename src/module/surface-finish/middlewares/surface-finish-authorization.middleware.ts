import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  roleHasSurfaceFinishCapability,
  type SurfaceFinishCapability,
} from "../domain/surface-finish-policy";

/**
 * Garde de capacité Finitions (#210). Refus par défaut : un compte authentifié
 * n'obtient aucun droit implicite. Masquer un bouton côté interface n'est jamais
 * une autorisation — cette garde est rejouée à chaque requête, et le domaine la
 * revérifie pour les règles qui dépendent de l'objet manipulé (force-create,
 * override d'un texte généré).
 */
export function requireSurfaceFinishCapability(capability: SurfaceFinishCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (!roleHasSurfaceFinishCapability(req.user.role, capability)) {
      next(
        new HttpError(
          403,
          "SURFACE_FINISH_CAPABILITY_REQUIRED",
          `La capacité Finitions '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}
