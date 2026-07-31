import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import {
  roleHasTraceabilityCapability,
  type TraceabilityCapability,
} from "../domain/traceability-policy";

/**
 * Garde de capacité Traçabilité (#142). Refus par défaut : un utilisateur
 * authentifié n'obtient aucun droit implicite sur la généalogie transversale.
 *
 * Cette garde n'est que la première couche. Le service revérifie la visibilité
 * du point de départ ET de chaque nœud rencontré, parce qu'une route autorisée
 * ne dit rien de l'objet manipulé — c'est exactement le vecteur d'IDOR que ce
 * module doit fermer.
 */
export function requireTraceabilityCapability(capability: TraceabilityCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasTraceabilityCapability(req.user.role, capability)
    ) {
      next(
        new HttpError(
          403,
          "TRACEABILITY_CAPABILITY_REQUIRED",
          `La capacité Traçabilité '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}
