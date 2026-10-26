import { z } from "zod";
import type { Pool } from "pg";
import { HttpError } from "../../../utils/httpError";
import {
  sharedDirectoryClient,
  sharedDirectorySite,
} from "../../../shared-directory/site-runtime";
import { resolveAccessProfile } from "../../access-control/services/access-control.service";
import type { ResolvedAccessProfile } from "../../access-control/types/access-control.types";
import {
  companySchema,
  companyMembershipSchema,
  resolveActiveCompanyContext,
  type CompanyContext,
} from "../domain/company-context";
import {
  companyEnvironmentSchema,
  companyIdSchema,
  companyRuntimeConfiguration,
} from "./company-runtime.config";

export type CompanyActor = {
  id: number;
  directory_session?: string;
  directory_profile_id?: string;
};
export type DirectoryCompanyTransport = {
  call<T>(operation: string, payload: unknown): Promise<T>;
};
export const companySummarySchema = companySchema.pick({
  id: true,
  code: true,
  name: true,
  profile: true,
});
const instanceSchema = z
  .object({
    company_id: companyIdSchema,
    environment: companyEnvironmentSchema,
    site_id: z.string().min(1),
    active: z.literal(true),
  })
  .strict();
const snapshotSchema = z
  .object({
    company: companySchema,
    membership: companyMembershipSchema
      .omit({ enabled_module_keys: true })
      .extend({
        allowed_module_keys: companySchema.shape.enabled_module_keys,
        denied_module_keys: companySchema.shape.enabled_module_keys,
      }),
    instance: instanceSchema,
  })
  .strict();
const listSchema = z
  .object({
    environment: companyEnvironmentSchema,
    companies: z.array(companySummarySchema).max(1000),
  })
  .strict();
const switchResponseSchema = z
  .object({
    ticket: z.string().regex(/^[a-f0-9]{64}$/),
    target_company_id: companyIdSchema,
    environment: companyEnvironmentSchema,
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type RuntimeCompanyAccess = {
  context: CompanyContext;
  summary: z.infer<typeof companySummarySchema>;
};
export type CompanyView = {
  contract_version: 1;
  mode: "LEGACY" | "COMPANY";
  active_company: z.infer<typeof companySummarySchema> | null;
  environment: "cerp_prod" | "cerp_test";
  available_companies: z.infer<typeof companySummarySchema>[];
  module_keys: readonly string[];
  commercial_projection_capabilities: readonly string[];
  workspace: "ACCUEIL" | "INDUSTRIAL" | null;
};

type Dependencies = {
  env: () => NodeJS.ProcessEnv;
  directory: () => DirectoryCompanyTransport | null;
  site: () => string | null;
  accessProfile: (id: number) => Promise<ResolvedAccessProfile | null>;
};

/** Authority errors retain a bounded public status, without leaking RPC payloads. */
export function companyAuthorityFailure(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const candidate = error as { status?: number; code?: string };
  if (candidate?.status === 400)
    throw new HttpError(
      400,
      "COMPANY_CONFIGURATION_INVALID",
      "Vérifiez les données de configuration de l'entreprise.",
    );
  if (candidate?.status === 401)
    throw new HttpError(
      401,
      "MFA_REQUIRED",
      "Une nouvelle connexion est requise.",
    );
  if (candidate?.status === 403)
    throw new HttpError(
      403,
      "COMPANY_ACCESS_DENIED",
      "Accès à cette entreprise refusé.",
    );
  if (candidate?.status === 404)
    throw new HttpError(
      404,
      "COMPANY_CONFIGURATION_NOT_FOUND",
      "Cette configuration d'entreprise est introuvable.",
    );
  if (candidate?.status === 409)
    throw new HttpError(
      409,
      "COMPANY_SWITCH_CONFLICT",
      "Cette demande doit être vérifiée avant de réessayer.",
    );
  if (candidate?.status === 428)
    throw new HttpError(
      428,
      "MFA_STEP_UP_REQUIRED",
      "Confirmez votre double authentification.",
    );
  throw new HttpError(
    503,
    "COMPANY_CONTEXT_UNAVAILABLE",
    "Le contexte entreprise est momentanément indisponible.",
  );
}

export function createCompanyRuntimeService(deps: Dependencies) {
  function configuration() {
    return companyRuntimeConfiguration(deps.env());
  }
  function directory() {
    const client = deps.directory();
    if (!client)
      throw new HttpError(
        503,
        "COMPANY_DIRECTORY_REQUIRED",
        "L'annuaire commun est requis.",
      );
    return client;
  }
  function session(actor: CompanyActor) {
    if (!actor.directory_session || !actor.directory_profile_id)
      throw new HttpError(
        401,
        "MFA_REQUIRED",
        "Une nouvelle connexion est requise.",
      );
    return actor.directory_session;
  }
  async function access(
    actor: CompanyActor,
  ): Promise<RuntimeCompanyAccess | null> {
    const config = configuration();
    if (!config.enabled) return null;
    try {
      const raw = await directory().call("business-company-context", {
        directory_session: session(actor),
        input: {},
      });
      const snapshot = snapshotSchema.parse(raw);
      if (
        snapshot.instance.company_id !== config.company_id ||
        snapshot.instance.environment !== config.environment ||
        snapshot.instance.site_id !== deps.site()
      ) {
        throw new HttpError(
          503,
          "COMPANY_RUNTIME_BINDING_MISMATCH",
          "L'instance entreprise doit être vérifiée.",
        );
      }
      if (
        snapshot.membership.directory_profile_id !== actor.directory_profile_id
      )
        throw new HttpError(
          403,
          "COMPANY_ACCESS_DENIED",
          "Accès à cette entreprise refusé.",
        );
      const profile = await deps.accessProfile(actor.id);
      if (!profile)
        throw new HttpError(
          503,
          "ACCESS_CONTROL_UNAVAILABLE",
          "Le contrôle d'accès est indisponible.",
        );
      const denied = new Set(snapshot.membership.denied_module_keys),
        allowed = new Set(snapshot.membership.allowed_module_keys);
      const {
        denied_module_keys: _deniedKeys,
        allowed_module_keys: _allowedKeys,
        ...membership
      } = snapshot.membership;
      const context = resolveActiveCompanyContext(
        {
          central_account_id: snapshot.membership.central_account_id,
          directory_profile_id: actor.directory_profile_id,
          requested_company_id: config.company_id,
          company: snapshot.company,
          membership: {
            ...membership,
            enabled_module_keys: profile.modules
              .filter(
                (module) =>
                  module.allowed &&
                  allowed.has(module.module_key) &&
                  !denied.has(module.module_key),
              )
              .map((module) => module.module_key),
          },
        },
        { company_id: config.company_id, environment: config.environment },
      );
      const { id, code, name, profile: companyProfile } = snapshot.company;
      return { context, summary: { id, code, name, profile: companyProfile } };
    } catch (error) {
      companyAuthorityFailure(error);
    }
  }
  async function view(
    actor: CompanyActor,
    existing?: RuntimeCompanyAccess | null,
  ): Promise<CompanyView> {
    const config = configuration();
    if (!config.enabled) {
      const site = deps.site() ?? deps.env().CERP_SHARED_DIRECTORY_SITE;
      const environment =
        site?.startsWith("cerp_test") || site?.endsWith("_test")
          ? "cerp_test"
          : "cerp_prod";
      return {
        contract_version: 1,
        mode: "LEGACY",
        active_company: null,
        environment,
        available_companies: [],
        module_keys: [],
        commercial_projection_capabilities: [],
        workspace: null,
      };
    }
    try {
      const resolved = existing ?? (await access(actor));
      if (!resolved) throw new Error("Company context required");
      const list = listSchema.parse(
        await directory().call("business-company-list", {
          directory_session: session(actor),
          input: {},
        }),
      );
      if (
        list.environment !== config.environment ||
        !list.companies.some(
          (company) => company.id === resolved.context.company_id,
        )
      )
        throw new HttpError(
          403,
          "COMPANY_ACCESS_DENIED",
          "Accès à cette entreprise refusé.",
        );
      return {
        contract_version: 1,
        mode: "COMPANY",
        active_company: resolved.summary,
        environment: config.environment,
        available_companies: list.companies,
        module_keys: resolved.context.module_keys,
        commercial_projection_capabilities:
          resolved.context.commercial_projection_capabilities,
        workspace: resolved.context.workspace,
      };
    } catch (error) {
      companyAuthorityFailure(error);
    }
  }
  async function createSwitch(
    actor: CompanyActor,
    companyId: string,
    key: string,
  ) {
    const config = configuration();
    if (!config.enabled)
      throw new HttpError(
        409,
        "COMPANY_RUNTIME_NOT_ENABLED",
        "Le changement d'entreprise n'est pas activé.",
      );
    await access(actor);
    try {
      const result = switchResponseSchema.parse(
        await directory().call("business-company-switch-create", {
          directory_session: session(actor),
          input: { company_id: companyId, key },
        }),
      );
      if (
        result.target_company_id !== companyId ||
        result.environment !== config.environment ||
        Date.parse(result.expires_at) <= Date.now()
      )
        throw new Error("Invalid company switch scope");
      return result;
    } catch (error) {
      companyAuthorityFailure(error);
    }
  }
  return { configuration, directory, access, view, createSwitch };
}

export const companyRuntimeService = createCompanyRuntimeService({
  env: () => process.env,
  directory: () => sharedDirectoryClient(),
  site: () => sharedDirectorySite(),
  accessProfile: (id) => resolveAccessProfile(id),
});

export async function assertCompanyRuntimeAtStartup(db: Pick<Pool, "query">) {
  const config = companyRuntimeService.configuration();
  const site = sharedDirectorySite();
  const actual = (
    await db.query<{ database: string }>(
      "SELECT current_database() AS database",
    )
  ).rows[0]?.database;
  if (!config.enabled) {
    if (
      site?.startsWith("cerp_company_") ||
      actual?.startsWith("cerp_company_")
    )
      throw new Error("COMPANY_RUNTIME_REQUIRED_FOR_COMPANY_SITE");
    return;
  }
  if (!["off", "leader"].includes(process.env.CERP_BACKGROUND_WORKERS ?? ""))
    throw new Error("COMPANY_WORKER_MODE_REQUIRED");
  const binding = instanceSchema.parse(
    await companyRuntimeService
      .directory()
      .call("business-company-instance", { input: {} }),
  );
  if (
    binding.company_id !== config.company_id ||
    binding.environment !== config.environment ||
    binding.site_id !== site ||
    binding.site_id !== actual
  )
    throw new Error("COMPANY_RUNTIME_BINDING_MISMATCH");
}
