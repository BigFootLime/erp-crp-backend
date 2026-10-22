import type { RequestHandler } from "express";
import { grantAccountModuleAccessToRequest } from "../context/account-module-access.context";
import { resolveAccessProfile } from "../services/access-control.service";
import { hasRecentMfaAssurance } from "../../auth/middlewares/mfa-assurance.middleware";

export const ERP_CONFIGURATION_MODULE = "parametrage-erp";

/** Explicit live account permission; descriptive business roles never grant account administration. */
export const requireErpConfiguration: RequestHandler = (req, res, next) => {
  const userId = req.user?.id;
  if (typeof userId !== "number") {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }
  void resolveAccessProfile(userId).then(profile => {
    if (!profile) {
      res.status(503).json({ error: "Contrôle d’accès indisponible." });
      return;
    }
    if (!profile.is_superadmin && !profile.modules.some(m => m.module_key === ERP_CONFIGURATION_MODULE && m.allowed)) {
      res.status(403).json({ error: "Le droit Paramétrage ERP est requis." });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && (req.user?.mfa !== true || !hasRecentMfaAssurance(req.user))) {
      res.status(428).json({ code: "MFA_STEP_UP_REQUIRED", message: "Confirmez votre facteur MFA pour modifier le paramétrage ERP." });
      return;
    }
    grantAccountModuleAccessToRequest(req, { userId, moduleKey: ERP_CONFIGURATION_MODULE, elevated: true }, next);
  }).catch(() => {
    res.status(503).json({ error: "Contrôle d’accès indisponible." });
  });
};
