import { Router } from "express";
import { z } from "zod";
import pool from "../../../config/database";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { createAuthRateLimitMiddleware } from "../../auth/middlewares/auth-rate-limit.middleware";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import {
  directoryAuthenticationResult,
  sharedDirectorySite,
} from "../../../shared-directory/site-runtime";
import {
  COMPANY_HEADER,
  companyEnvironmentSchema,
  companyIdSchema,
} from "../runtime/company-runtime.config";
import {
  companyAuthorityFailure,
  companyRuntimeService,
} from "../runtime/company-runtime.service";

const router = Router();
const keySchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const exchangeSchema = z
  .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/), key: keySchema })
  .strict();
const switchSchema = z
  .object({ target_company_id: companyIdSchema, key: keySchema })
  .strict();
const companySignInLimit = createAuthRateLimitMiddleware("companySwitch");

/** The tenant is selected by a link, but only its fixed runtime can confirm it. */
export function assertCompanyLoginTarget(
  req: import("express").Request,
  allowRuntimeDefault = false,
) {
  const config = companyRuntimeService.configuration();
  if (!config.enabled) {
    if (req.get(COMPANY_HEADER) !== undefined)
      throw new HttpError(
        503,
        "COMPANY_RUNTIME_NOT_ENABLED",
        "Cette instance ne peut pas traiter ce contexte entreprise.",
      );
    return null;
  }
  const company = companyIdSchema.safeParse(req.get(COMPANY_HEADER));
  const environment = companyEnvironmentSchema.safeParse(
    req.get("X-CERP-Database"),
  );
  // Before credentials exist, a normal /login visit has no company UUID. The
  // instance is itself the authority for its one fixed active company.
  if (allowRuntimeDefault && req.get(COMPANY_HEADER) === undefined) {
    if (
      req.get("X-CERP-Database") !== undefined &&
      (!environment.success || environment.data !== config.environment)
    ) {
      throw new HttpError(
        403,
        "COMPANY_LOGIN_TARGET_MISMATCH",
        "Le lien de connexion entreprise n'est pas valide pour cette instance.",
      );
    }
    return { company_id: config.company_id, environment: config.environment };
  }
  if (
    !company.success ||
    !environment.success ||
    company.data !== config.company_id ||
    environment.data !== config.environment
  ) {
    throw new HttpError(
      403,
      "COMPANY_LOGIN_TARGET_MISMATCH",
      "Le lien de connexion entreprise n'est pas valide pour cette instance.",
    );
  }
  return { company_id: company.data, environment: environment.data };
}
export const companyLoginTargetMiddleware: import("express").RequestHandler = (
  req,
  _res,
  next,
) => {
  try {
    // The two fixed CRP sites keep supporting existing login forms and clients
    // which predate the company header. Tenant runtimes never receive this
    // compatibility default: their fixed company header remains mandatory.
    const site = sharedDirectorySite();
    assertCompanyLoginTarget(
      req,
      site === "cerp_prod" || site === "cerp_test",
    );
    next();
  } catch (error) {
    next(error);
  }
};

router.get(
  "/sign-in-context",
  companySignInLimit,
  asyncHandler(async (req, res) => {
    const target = assertCompanyLoginTarget(req, true);
    if (!target)
      throw new HttpError(
        404,
        "COMPANY_SIGN_IN_CONTEXT_NOT_FOUND",
        "Cette instance ne propose pas de connexion entreprise.",
      );
    try {
      const value = await companyRuntimeService
        .directory()
        .call<unknown>("business-company-sign-in-context", { input: {} });
      const context = z
        .object({
          company: z
            .object({
              id: companyIdSchema,
              code: z.string().min(1).max(64),
              name: z.string().min(1).max(200),
              profile: z.enum(["COMMERCIAL", "INDUSTRIAL"]),
            })
            .strict(),
          environment: companyEnvironmentSchema,
        })
        .strict()
        .parse(value);
      if (
        context.company.id !== target.company_id ||
        context.environment !== target.environment
      )
        throw new Error("COMPANY_SIGN_IN_CONTEXT_MISMATCH");
      res.setHeader("Cache-Control", "no-store");
      res.json(context);
    } catch (error) {
      companyAuthorityFailure(error);
    }
  }),
);

router.post(
  "/switches/exchange",
  companySignInLimit,
  asyncHandler(async (req, res) => {
    const config = companyRuntimeService.configuration();
    if (!config.enabled)
      throw new HttpError(
        503,
        "COMPANY_RUNTIME_NOT_ENABLED",
        "Le changement d'entreprise n'est pas activé.",
      );
    if (req.headers.authorization !== undefined)
      throw new HttpError(
        400,
        "COMPANY_SWITCH_SOURCE_BEARER_FORBIDDEN",
        "Cet échange exige un ticket d'entreprise.",
      );
    const header = companyIdSchema.safeParse(req.get(COMPANY_HEADER));
    if (
      !header.success ||
      header.data !== config.company_id ||
      req.get("X-CERP-Database") !== config.environment
    )
      throw new HttpError(
        403,
        "COMPANY_CONTEXT_MISMATCH",
        "Le contexte entreprise ne correspond pas à cette instance.",
      );
    const input = exchangeSchema.parse(req.body);
    try {
      const result = await companyRuntimeService
        .directory()
        .call<{
          directory_session: string;
          identity: { profile_id: string };
        }>("business-company-switch-redeem", { input });
      const userAgent = req.get("User-Agent") ?? null;
      const data = await directoryAuthenticationResult(pool, result, {
        ip: getClientIp(req),
        user_agent: userAgent,
        ...parseDevice(userAgent),
      });
      const user = data.user as { id?: number } | undefined;
      if (!Number.isSafeInteger(user?.id) || typeof data.token !== "string")
        throw new Error("Invalid company authentication response");
      const actor = {
        id: user!.id!,
        directory_session: result.directory_session,
        directory_profile_id: result.identity.profile_id,
      };
      res.json({
        ...data,
        company_context: await companyRuntimeService.view(actor),
      });
    } catch (error) {
      companyAuthorityFailure(error);
    }
  }),
);

router.use(authenticateToken);
router.get(
  "/context",
  asyncHandler(async (req, res) => {
    res.json(
      await companyRuntimeService.view(req.user!, req.businessCompanyAccess),
    );
  }),
);
router.post(
  "/switches",
  asyncHandler(async (req, res) => {
    const input = switchSchema.parse(req.body);
    res.json(
      await companyRuntimeService.createSwitch(
        req.user!,
        input.target_company_id,
        input.key,
      ),
    );
  }),
);

// Directory revalidates the live owner and recent MFA for every operation.
const adminCall = (
  operation: string,
  input: (req: import("express").Request) => unknown,
) =>
  asyncHandler(async (req, res) => {
    if (!req.user?.directory_session)
      throw new HttpError(
        401,
        "DIRECTORY_SESSION_REQUIRED",
        "Une nouvelle connexion est requise.",
      );
    try {
      res.json(
        await companyRuntimeService
          .directory()
          .call(operation, {
            directory_session: req.user.directory_session,
            input: input(req),
          }),
      );
    } catch (error) {
      companyAuthorityFailure(error);
    }
  });
router.get(
  "/admin/companies",
  adminCall("business-companies-admin-list", () => ({})),
);
router.get(
  "/admin/options",
  adminCall("business-companies-admin-options", (req) => ({
    search: req.query.search ?? "",
  })),
);
router.get(
  "/admin/companies/:companyId",
  adminCall("business-companies-admin-detail", (req) => ({
    company_id: companyIdSchema.parse(req.params.companyId),
  })),
);
router.post(
  "/admin/companies",
  adminCall("business-companies-admin-create", (req) => req.body),
);
router.patch(
  "/admin/companies/:companyId",
  adminCall("business-companies-admin-update", (req) => ({
    ...req.body,
    id: companyIdSchema.parse(req.params.companyId),
  })),
);
router.put(
  "/admin/companies/:companyId/memberships/:profileId",
  adminCall("business-companies-admin-membership", (req) => ({
    ...req.body,
    company_id: companyIdSchema.parse(req.params.companyId),
    profile_id: companyIdSchema.parse(req.params.profileId),
  })),
);
router.put(
  "/admin/companies/:companyId/instances",
  adminCall("business-companies-admin-instance", (req) => ({
    ...req.body,
    company_id: companyIdSchema.parse(req.params.companyId),
  })),
);
router.get(
  "/admin/companies/:companyId/instances/:environment/memberships/:profileId/administrative-level",
  adminCall("business-companies-admin-site-superadmin-read", (req) => ({
    company_id: companyIdSchema.parse(req.params.companyId),
    environment: companyEnvironmentSchema.parse(req.params.environment),
    profile_id: companyIdSchema.parse(req.params.profileId),
  })),
);
router.put(
  "/admin/companies/:companyId/instances/:environment/memberships/:profileId/administrative-level",
  adminCall("business-companies-admin-site-superadmin-set", (req) => ({
    ...req.body,
    company_id: companyIdSchema.parse(req.params.companyId),
    environment: companyEnvironmentSchema.parse(req.params.environment),
    profile_id: companyIdSchema.parse(req.params.profileId),
  })),
);

export default router;
