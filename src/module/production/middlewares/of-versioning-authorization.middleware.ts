// Gardes d'autorisation du chantier #370.
//
// Refus par défaut : être authentifié n'accorde aucun droit. La garde est rejouée
// à chaque requête — masquer un bouton côté UI n'a jamais été une autorisation.

import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasOfCapability, type OfCapability } from "../domain/of-rbac";

export function requireOfCapability(capability: OfCapability): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || typeof req.user.id !== "number") {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasOfCapability(req.user.role, capability)
    ) {
      next(
        new HttpError(
          403,
          "OF_CAPABILITY_REQUIRED",
          `La capacité OF '${capability}' est requise pour cette action.`
        )
      );
      return;
    }
    next();
  };
}

/**
 * Toute commande à effet exige une clé d'idempotence.
 *
 * Sans elle, un double-clic sur « Émettre » produirait deux documents officiels,
 * et un retry réseau deux dossiers d'AR. Le contrat est donc refusé en amont
 * plutôt que deviné.
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

/** Clé d'idempotence normalisée, ou `null` quand la route ne l'exige pas. */
export function idempotencyKeyOf(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers["idempotency-key"];
  const key = typeof raw === "string" ? raw.trim() : "";
  return key.length ? key : null;
}
