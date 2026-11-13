import type { Request, RequestHandler } from "express";
import type { CompanyContext } from "../domain/company-context";
import { HttpError } from "../../../utils/httpError";
import {
  companyRuntimeService,
  type RuntimeCompanyAccess,
} from "./company-runtime.service";
import { COMPANY_HEADER, companyIdSchema } from "./company-runtime.config";

declare global {
  namespace Express {
    interface Request {
      businessCompanyAccess?: RuntimeCompanyAccess;
    }
  }
}

/** Called after central account validation, before any protected handler. */
export const enforceAuthenticatedCompany: RequestHandler = (
  req,
  _res,
  next,
) => {
  void (async () => {
    const config = companyRuntimeService.configuration();
    const header = req.get(COMPANY_HEADER);
    if (!config.enabled) {
      if (header !== undefined)
        throw new HttpError(
          503,
          "COMPANY_RUNTIME_NOT_ENABLED",
          "Cette instance ne peut pas traiter ce contexte entreprise.",
        );
      return;
    }
    const discovery =
      req.originalUrl.split("?", 1)[0].replace(/\/$/, "") ===
      "/api/v1/entreprises/context";
    if (header === undefined && !discovery)
      throw new HttpError(
        403,
        "COMPANY_CONTEXT_REQUIRED",
        "Sélectionnez votre entreprise.",
      );
    if (req.get("X-CERP-Database") !== config.environment)
      throw new HttpError(
        403,
        "COMPANY_ENVIRONMENT_MISMATCH",
        "L'environnement ne correspond pas à cette instance.",
      );
    if (header !== undefined) {
      const parsed = companyIdSchema.safeParse(header);
      if (!parsed.success || parsed.data !== config.company_id)
        throw new HttpError(
          403,
          "COMPANY_CONTEXT_MISMATCH",
          "Le contexte entreprise ne correspond pas à cette instance.",
        );
    }
    if (!req.user)
      throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    const access = await companyRuntimeService.access(req.user);
    if (!access)
      throw new HttpError(
        503,
        "COMPANY_CONTEXT_UNAVAILABLE",
        "Le contexte entreprise est indisponible.",
      );
    req.businessCompanyAccess = access;
  })().then(() => next(), next);
};

export function companyContextForRequest(
  req: Request,
): CompanyContext | undefined {
  return req.businessCompanyAccess?.context;
}
