// GED centrale CERP (ADR-0037) — garde de capacité.
//
// Refus par défaut : un utilisateur authentifié n'obtient aucun droit documentaire
// implicite. Masquer un bouton côté UI n'est jamais une autorisation ; cette
// garde est rejouée à chaque requête.

import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { gedRoleKeys, type GedCapability } from "../domain/ged-policy";
import { repoActorHasAnyCapability } from "../repository/ged.repository";

export function requireGedCapability(capability: GedCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    const roleKeys = gedRoleKeys(req.user);
    void repoActorHasAnyCapability(roleKeys, capability)
      .then((granted) => {
        if (!granted) {
          next(
            new HttpError(
              403,
              "GED_CAPABILITY_REQUIRED",
              `La capacité GED '${capability}' est requise.`
            )
          );
          return;
        }
        next();
      })
      .catch(next);
  };
}
