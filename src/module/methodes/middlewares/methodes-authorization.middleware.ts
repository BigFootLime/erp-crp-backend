import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasMethodesCapability, type MethodesCapability } from "../domain/methodes-policy";

/**
 * Garde de capacité Méthodes. Refus par défaut : un compte authentifié n'obtient
 * aucun droit implicite sur les référentiels de gamme ni sur les taux horaires.
 * Masquer un bouton côté interface n'est jamais une autorisation — cette garde
 * est rejouée à chaque requête.
 */
export function requireMethodesCapability(capability: MethodesCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasMethodesCapability(req.user.role, capability)
    ) {
      next(new HttpError(403, "METHODES_CAPABILITY_REQUIRED", `La capacité Méthodes '${capability}' est requise.`));
      return;
    }
    next();
  };
}
