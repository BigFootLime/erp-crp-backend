import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { accountHasSensitiveCapability, type SensitiveCapability } from "../domain/sensitive-capabilities";
import { repoAccountSensitiveCapabilities } from "../repository/sensitive-capabilities.repository";
import { installSensitiveCapabilities } from "../context/account-module-access.context";
import { requireRecentMfa } from "../../auth/middlewares/mfa-assurance.middleware";

declare global {
  namespace Express {
    interface Request { sensitiveCapabilities?: readonly SensitiveCapability[] }
  }
}

/** The active MFA claim required for sensitive read surfaces, without a step-up. */
export function hasActiveSensitiveMfaAssurance(req: Request): boolean {
  return req.user?.mfa === true
    && req.user.amr?.some((method) => method === "totp" || method === "recovery_code") === true;
}

export async function loadSensitiveCapabilities(req: Request): Promise<void> {
  const id = req.user?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const state = await repoAccountSensitiveCapabilities(id);
  if (!state.active) throw new HttpError(403, "ACCOUNT_INACTIVE", "Accès interdit.");
  installSensitiveCapabilities(req, state.capabilities);
}

export function requireSensitiveCapability(capability: SensitiveCapability): RequestHandler {
  return (req, res, next) => {
    const id = req.user?.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    void repoAccountSensitiveCapabilities(id).then(state => {
      if (!accountHasSensitiveCapability(state, capability)) {
        throw new HttpError(403, "SENSITIVE_CAPABILITY_REQUIRED", "Une habilitation sensible est requise pour cette action.");
      }
      if (!hasActiveSensitiveMfaAssurance(req)) {
        throw new HttpError(401, "MFA_REQUIRED", "Une connexion avec double authentification est requise pour cette action.");
      }
      installSensitiveCapabilities(req, state.capabilities);
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) next();
      else requireRecentMfa()(req, res, next);
    }).catch(next);
  };
}
