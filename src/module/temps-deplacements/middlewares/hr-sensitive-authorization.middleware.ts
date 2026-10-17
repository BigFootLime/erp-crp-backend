import type { Request, RequestHandler } from "express";

import { hasRecentMfaAssurance, requireRecentMfa } from "../../auth/middlewares/mfa-assurance.middleware";
import { installSensitiveCapabilities } from "../../access-control/context/account-module-access.context";
import { accountHasSensitiveCapability } from "../../access-control/domain/sensitive-capabilities";
import { hasActiveSensitiveMfaAssurance } from "../../access-control/middlewares/sensitive-capability.middleware";
import { repoAccountSensitiveCapabilities } from "../../access-control/repository/sensitive-capabilities.repository";
import type { AccountCapabilityState } from "../../access-control/domain/sensitive-capabilities";
import { HttpError } from "../../../utils/httpError";

type HrSensitiveAction = "read" | "write";

export type HrPermissions = {
  can_read_sensitive: boolean;
  can_write_sensitive: boolean;
  mfa_required: boolean;
};

function capabilityFor(action: HrSensitiveAction): "hr.sensitive.read" | "hr.sensitive.write" {
  return action === "read" ? "hr.sensitive.read" : "hr.sensitive.write";
}

async function resolveHrPermissions(req: Request): Promise<{ permissions: HrPermissions; state: AccountCapabilityState }> {
  const userId = req.user?.id;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const state = await repoAccountSensitiveCapabilities(userId);
  if (!state.active) throw new HttpError(403, "ACCOUNT_INACTIVE", "Accès interdit.");

  installSensitiveCapabilities(req, state.capabilities);
  const mfa = hasActiveSensitiveMfaAssurance(req);
  const hasRead = accountHasSensitiveCapability(state, "hr.sensitive.read");
  const hasWrite = accountHasSensitiveCapability(state, "hr.sensitive.write");
  return {
    permissions: {
      can_read_sensitive: hasRead && mfa,
      can_write_sensitive: hasWrite && mfa,
      mfa_required: (hasRead || hasWrite) && !mfa,
    },
    state,
  };
}

export async function getHrSensitivePermissions(req: Request): Promise<HrPermissions> {
  return (await resolveHrPermissions(req)).permissions;
}

export async function assertHrSensitiveAction(req: Request, action: HrSensitiveAction): Promise<void> {
  const { permissions, state } = await resolveHrPermissions(req);
  if (permissions[action === "read" ? "can_read_sensitive" : "can_write_sensitive"]) {
    if (action === "write" && !hasRecentMfaAssurance(req.user)) {
      throw new HttpError(428, "MFA_STEP_UP_REQUIRED", "Confirmez votre facteur MFA pour cette action sensible.");
    }
    return;
  }

  if (!accountHasSensitiveCapability(state, capabilityFor(action))) {
    throw new HttpError(403, "SENSITIVE_CAPABILITY_REQUIRED", "Une habilitation RH sensible est requise pour cette action.");
  }
  throw new HttpError(428, "MFA_STEP_UP_REQUIRED", "Confirmez votre facteur MFA pour cette action sensible.");
}

export function requireHrSensitive(action: HrSensitiveAction): RequestHandler {
  return (req, res, next) => {
    void assertHrSensitiveAction(req, action).then(() => {
      if (action === "read" || ["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        next();
        return;
      }
      requireRecentMfa()(req, res, next);
    }).catch(next);
  };
}

export const requireHrSensitiveRead = requireHrSensitive("read");
export const requireHrSensitiveWrite = requireHrSensitive("write");
