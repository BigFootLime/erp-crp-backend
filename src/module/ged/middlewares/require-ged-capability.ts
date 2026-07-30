// GED centrale CERP (ADR-0037) — garde de capacité.
//
// Refus par défaut : un utilisateur authentifié n'obtient aucun droit documentaire
// implicite. Masquer un bouton côté UI n'est jamais une autorisation ; cette
// garde est rejouée à chaque requête.

import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasGedCapability, type GedCapability } from "../domain/ged-policy";

export function requireGedCapability(capability: GedCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasGedCapability(req.user.role, capability)
    ) {
      next(
        new HttpError(403, "GED_CAPABILITY_REQUIRED", `La capacité GED '${capability}' est requise.`)
      );
      return;
    }
    next();
  };
}
