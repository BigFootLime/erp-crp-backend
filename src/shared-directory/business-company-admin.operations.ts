import type { Express, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  companySchema,
  COMMERCIAL_COMPANY_MODULE_KEYS,
} from "../module/entreprises/domain/company-context";
import { siteIdSchema } from "./model";
import { validateDirectorySession } from "./session.repository";
import { requireDirectoryOwner } from "./authority";
import {
  repoCreateBusinessCompany,
  repoListBusinessCompanies,
  repoReadBusinessCompanyAdministration,
  repoReadBusinessCompanySiteAdministrativeLevel,
  repoSearchBusinessCompanyProfiles,
  repoSetBusinessCompanyInstance,
  repoSetBusinessCompanyMembership,
  repoSetBusinessCompanySiteAdministrativeLevel,
  repoUpdateBusinessCompany,
} from "../module/entreprises/repository/company-directory.repository";
import { MODULE_CATALOG } from "../module/access-control/domain/module-catalog";
import { HttpError } from "../utils/httpError";
import { readApprovedAccountAccessSource } from "./approved-account-access-source";
import { repoReadApprovedSourceBinding, repoReadApprovedCompanyOptions, repoApplyApprovedCompanyAccess } from "../module/entreprises/repository/approved-company-access.repository";
import { approvedCompanyAccessUpdateSchema } from "../module/entreprises/domain/approved-company-access";

type Wrap = (
  work: (req: Request, res: Response) => Promise<void>,
) => RequestHandler;
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const envelope = z
  .object({
    directory_session: z.string().regex(/^dir_[a-f0-9]{64}$/),
    input: z.unknown(),
  })
  .strict();
const membershipSchema = z
  .object({
    company_id: uuid,
    profile_id: uuid,
    status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]),
    allowed_module_keys: companySchema.shape.enabled_module_keys,
    denied_module_keys: companySchema.shape.enabled_module_keys,
    enabled_commercial_projection_capabilities:
      companySchema.shape.enabled_commercial_projection_capabilities,
    expected_version: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
const adminCompanySchema = companySchema.superRefine((value, context) => {
  if (
    value.profile === "COMMERCIAL" &&
    value.enabled_module_keys.some(
      (key) => !COMMERCIAL_COMPANY_MODULE_KEYS.includes(key as any),
    )
  )
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Commercial company module is not allowed",
    });
  if (
    value.profile === "INDUSTRIAL" &&
    value.enabled_commercial_projection_capabilities.length
  )
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Commercial projections require a commercial company",
    });
});
const instanceSchema = z
  .object({
    company_id: uuid,
    environment: z.enum(["cerp_prod", "cerp_test"]),
    site_id: siteIdSchema,
    active: z.boolean(),
    expected_version: z.number().int().min(0).max(2_147_483_646),
  })
  .strict()
  .superRefine((value, context) => {
    const production =
      value.site_id === "cerp_prod" || value.site_id.endsWith("_prod");
    if (production !== (value.environment === "cerp_prod"))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Instance environment mismatch",
      });
  });
const siteAdministrativeLevelSchema = z
  .object({
    company_id: uuid,
    profile_id: uuid,
    environment: z.enum(["cerp_prod", "cerp_test"]),
    is_superadmin: z.boolean(),
    expected_version: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
const siteAdministrativeLevelReadSchema = siteAdministrativeLevelSchema.omit({
  is_superadmin: true,
  expected_version: true,
});

/** Central management only: it registers metadata and never provisions a DB. */
export function mountDirectoryBusinessCompanyAdministration(
  app: Express,
  db: Pool,
  wrap: Wrap,
  enabled: boolean,
  approvedSource?: {
    authorityId: string;
    keys: () => Promise<ReadonlyMap<string, string>>;
    transport?: typeof fetch;
  },
) {
  if (!enabled) return;
  const endpoint = (
    operation: string,
    work: (
      input: unknown,
      actor: Awaited<ReturnType<typeof validateDirectorySession>>,
    ) => Promise<unknown>,
  ) => {
    app.post(
      `/internal/directory/${operation}`,
      wrap(async (req, res) => {
        const parsed = envelope.parse(req.body);
        const actor = await validateDirectorySession(
          db,
          req.directoryCaller!,
          parsed.directory_session,
          { autoProvisionTestMembership: false },
        );
        await requireDirectoryOwner(db, actor);
        try {
          res.json(await work(parsed.input, actor));
        } catch (error) {
          const failure = error as { message?: string; code?: string };
          if (
            failure.code === "23505" ||
            failure.message?.endsWith("VERSION_CONFLICT")
          )
            throw new HttpError(
              409,
              "BUSINESS_COMPANY_CONFIGURATION_CONFLICT",
              "Cette configuration a changé. Rechargez-la avant de réessayer.",
            );
          if (failure.message === "BUSINESS_COMPANY_NOT_FOUND")
            throw new HttpError(
              404,
              "BUSINESS_COMPANY_NOT_FOUND",
              "Entreprise introuvable.",
            );
          throw error;
        }
      }),
    );
  };
  const audit = (
    actor: Awaited<ReturnType<typeof validateDirectorySession>>,
  ) => ({
    user_id: actor.source_user_id,
    ip: null,
    user_agent: null,
    device_type: null,
    os: null,
    browser: null,
  });
  const approvedSnapshot = async (profileId: string) => {
    if (!approvedSource) throw new HttpError(503, "DIRECTORY_UNAVAILABLE", "Les droits approuvés sont momentanément indisponibles.");
    const binding = await repoReadApprovedSourceBinding(db, profileId);
    const key = (await approvedSource.keys()).get(binding.site);
    if (!key) throw new HttpError(503, "DIRECTORY_UNAVAILABLE", "Les droits approuvés sont momentanément indisponibles.");
    const snapshot = await readApprovedAccountAccessSource({ authority_id: approvedSource.authorityId, profile_id: profileId, source_site: binding.site }, key, approvedSource.transport);
    return { binding, snapshot };
  };
  endpoint("business-companies-admin-approved-access-options", async input => {
    const parsed = z.object({ profile_id: uuid }).strict().parse(input);
    const { binding, snapshot } = await approvedSnapshot(parsed.profile_id);
    return repoReadApprovedCompanyOptions(db, binding, snapshot);
  });
  endpoint("business-companies-admin-approved-access-set", async (input, actor) => {
    const parsed = approvedCompanyAccessUpdateSchema.extend({ profile_id: uuid }).strict().parse(input);
    const { profile_id, ...selection } = parsed;
    const { binding, snapshot } = await approvedSnapshot(profile_id);
    return repoApplyApprovedCompanyAccess(db, binding, snapshot, selection, actor);
  });
  endpoint("business-companies-admin-list", async (input) => {
    z.object({}).strict().parse(input);
    return { companies: await repoListBusinessCompanies(db) };
  });
  endpoint("business-companies-admin-detail", async (input) =>
    repoReadBusinessCompanyAdministration(
      db,
      z.object({ company_id: uuid }).strict().parse(input).company_id,
    ),
  );
  endpoint("business-companies-admin-options", async (input) => {
    const { search } = z
      .object({ search: z.string().trim().max(100).default("") })
      .strict()
      .parse(input);
    return {
      profiles: await repoSearchBusinessCompanyProfiles(db, search),
      modules: MODULE_CATALOG.map((module) => ({
        key: module.module_key,
        label: module.label,
        category: module.category,
        commercial_allowed: (
          COMMERCIAL_COMPANY_MODULE_KEYS as readonly string[]
        ).includes(module.module_key),
      })),
    };
  });
  endpoint("business-companies-admin-create", async (input, actor) => {
    const { id, ...company } = adminCompanySchema.parse(input);
    return repoCreateBusinessCompany(
      db,
      { company_id: id, ...company },
      audit(actor),
    );
  });
  endpoint("business-companies-admin-update", async (input, actor) => {
    const { expected_version, ...companyInput } = companySchema
      .extend({
        expected_version: z.number().int().positive().max(2_147_483_646),
      })
      .parse(input);
    const { id, ...company } = adminCompanySchema.parse(companyInput);
    if (
      company.status !== "ACTIVE" &&
      (
        await db.query(
          "SELECT 1 FROM public.cerp_business_company_instances WHERE company_id=$1::uuid AND site_id=$2",
          [id, actor.database],
        )
      ).rows.length
    ) {
      throw new HttpError(
        409,
        "BUSINESS_COMPANY_CURRENT_CONTEXT_REQUIRED",
        "Basculez vers une autre entreprise avant de désactiver celle-ci.",
      );
    }
    return repoUpdateBusinessCompany(
      db,
      { company_id: id, ...company, expected_version },
      audit(actor),
    );
  });
  endpoint("business-companies-admin-membership", async (input, actor) => {
    const parsed = membershipSchema.parse(input);
    if (
      parsed.profile_id === actor.profile_id &&
      parsed.status !== "ACTIVE" &&
      (
        await db.query(
          "SELECT 1 FROM public.cerp_business_company_instances WHERE company_id=$1::uuid AND site_id=$2",
          [parsed.company_id, actor.database],
        )
      ).rows.length
    ) {
      throw new HttpError(
        409,
        "BUSINESS_COMPANY_CURRENT_MEMBERSHIP_REQUIRED",
        "Basculez vers une autre entreprise avant de retirer votre accès à celle-ci.",
      );
    }
    return repoSetBusinessCompanyMembership(db, parsed, audit(actor));
  });
  endpoint("business-companies-admin-instance", async (input, actor) => {
    const parsed = instanceSchema.parse(input);
    const current = (
      await db.query<{ site_id: string }>(
        "SELECT site_id FROM public.cerp_business_company_instances WHERE company_id=$1::uuid AND environment=$2",
        [parsed.company_id, parsed.environment],
      )
    ).rows[0];
    if (
      current?.site_id === actor.database &&
      (!parsed.active || parsed.site_id !== actor.database)
    )
      throw new HttpError(
        409,
        "BUSINESS_COMPANY_CURRENT_INSTANCE_REQUIRED",
        "Basculez vers une autre entreprise avant de modifier cette instance.",
      );
    return repoSetBusinessCompanyInstance(db, parsed, audit(actor));
  });
  endpoint("business-companies-admin-site-superadmin-read", async (input) =>
    repoReadBusinessCompanySiteAdministrativeLevel(
      db,
      siteAdministrativeLevelReadSchema.parse(input),
    ),
  );
  endpoint("business-companies-admin-site-superadmin-set", async (input, actor) =>
    repoSetBusinessCompanySiteAdministrativeLevel(
      db,
      actor,
      siteAdministrativeLevelSchema.parse(input),
    ),
  );
}
