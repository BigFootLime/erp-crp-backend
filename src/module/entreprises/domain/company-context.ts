import { z } from "zod";

import {
  MODULE_KEYS,
  getModuleCatalogEntry,
} from "../../access-control/domain/module-catalog";

/** Canonical lower-case UUIDs prevent case-only company/profile confusion. */
const UUID = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const CENTRAL_ACCOUNT_ID = z.number().int().safe().positive();
const KNOWN_MODULE_KEYS = new Set(MODULE_KEYS);

export const COMPANY_PROFILES = ["COMMERCIAL", "INDUSTRIAL"] as const;
export const COMPANY_STATUSES = ["ACTIVE", "SUSPENDED", "RETIRED"] as const;
export const MEMBERSHIP_STATUSES = ["ACTIVE", "SUSPENDED", "REVOKED"] as const;
export const CERP_ENVIRONMENTS = ["cerp_prod", "cerp_test"] as const;
export const COMMERCIAL_PROJECTION_CAPABILITIES = [
  "stock.projection.read",
  "livraisons.projection.read",
] as const;

export type CompanyProfile = (typeof COMPANY_PROFILES)[number];
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type CERPEnvironment = (typeof CERP_ENVIRONMENTS)[number];
export type CommercialProjectionCapability =
  (typeof COMMERCIAL_PROJECTION_CAPABILITIES)[number];
export type CompanyCapability = CommercialProjectionCapability;

function knownModuleKey(value: string, context: z.RefinementCtx): void {
  if (!KNOWN_MODULE_KEYS.has(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown ERP module key: ${value}`,
    });
  }
}

const moduleKeysSchema = z
  .array(z.string().min(1).max(100))
  .max(100)
  .superRefine((keys, context) => {
    const seen = new Set<string>();
    for (const [index, key] of keys.entries()) {
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate ERP module key: ${key}`,
        });
      }
      seen.add(key);
      knownModuleKey(key, context);
    }
  });

export const companySchema = z
  .object({
    id: UUID,
    code: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9-]+$/),
    name: z.string().trim().min(1).max(200),
    status: z.enum(COMPANY_STATUSES),
    profile: z.enum(COMPANY_PROFILES),
    /** Enterprise-level policy, intersected with the already-resolved ACL snapshot below. */
    enabled_module_keys: moduleKeysSchema,
    enabled_commercial_projection_capabilities: z
      .array(z.enum(COMMERCIAL_PROJECTION_CAPABILITIES))
      .max(2)
      .superRefine((items, context) => {
        if (new Set(items).size !== items.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate commercial projection capability",
          });
        }
      }),
  })
  .strict();

export const companyMembershipSchema = z
  .object({
    /** Stable central numeric account identity; existing local user IDs are not rewritten here. */
    central_account_id: CENTRAL_ACCOUNT_ID,
    /** Shared Directory UUID used by the current identity projection. */
    directory_profile_id: UUID,
    company_id: UUID,
    status: z.enum(MEMBERSHIP_STATUSES),
    /**
     * Immutable-at-read ACL snapshot resolved by the central Directory (ADR-0049).
     * It is not a role grant and must never be reconstructed from role labels.
     */
    enabled_module_keys: moduleKeysSchema,
    enabled_commercial_projection_capabilities: z
      .array(z.enum(COMMERCIAL_PROJECTION_CAPABILITIES))
      .max(2)
      .superRefine((items, context) => {
        if (new Set(items).size !== items.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate commercial projection capability",
          });
        }
      }),
  })
  .strict();

/** Runtime binding is intentionally independent of the company UUID. */
export const fixedCompanyRuntimeSchema = z
  .object({
    environment: z.enum(CERP_ENVIRONMENTS),
    company_id: UUID,
  })
  .strict();

export const companyScopedReferenceSchema = z
  .object({
    company_id: UUID,
    id: z.string().uuid(),
  })
  .strict();

export const resolveCompanyContextInputSchema = z
  .object({
    central_account_id: CENTRAL_ACCOUNT_ID,
    directory_profile_id: UUID,
    requested_company_id: UUID,
    company: companySchema,
    membership: companyMembershipSchema,
  })
  .strict();

export type Company = z.infer<typeof companySchema>;
export type CompanyMembership = z.infer<typeof companyMembershipSchema>;
export type FixedCompanyRuntime = z.infer<typeof fixedCompanyRuntimeSchema>;
export type CompanyScopedReference = z.infer<
  typeof companyScopedReferenceSchema
>;
export type ResolveCompanyContextInput = z.infer<
  typeof resolveCompanyContextInputSchema
>;

export type CompanyContext = Readonly<{
  central_account_id: number;
  directory_profile_id: string;
  company_id: string;
  environment: CERPEnvironment;
  profile: CompanyProfile;
  workspace: "ACCUEIL" | "INDUSTRIAL";
  module_keys: readonly string[];
  commercial_projection_capabilities: readonly CommercialProjectionCapability[];
}>;

export class CompanyContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanyContextError";
  }
}

function intersect(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const allowed = new Set(right);
  return [...new Set(left)].filter((key) => allowed.has(key)).sort();
}

function assertParsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new CompanyContextError(
      "COMPANY_CONTEXT_INVALID",
      parsed.error.message,
    );
  return parsed.data;
}

/** A membership only grants access when its state says so explicitly. */
export function assertLiveMembership(
  membershipInput: unknown,
): CompanyMembership {
  const membership = assertParsed(companyMembershipSchema, membershipInput);
  if (membership.status !== "ACTIVE") {
    throw new CompanyContextError(
      "COMPANY_MEMBERSHIP_NOT_ACTIVE",
      "The company membership is not active.",
    );
  }
  return membership;
}

/** A fixed runtime may never serve a requested company other than its own binding. */
export function assertFixedRuntimeCompany(
  runtimeInput: unknown,
  requestedCompanyId: unknown,
): FixedCompanyRuntime {
  const runtime = assertParsed(fixedCompanyRuntimeSchema, runtimeInput);
  const companyId = UUID.safeParse(requestedCompanyId);
  if (!companyId.success) {
    throw new CompanyContextError(
      "COMPANY_REQUIRED",
      "An explicit company UUID is required.",
    );
  }
  if (runtime.company_id !== companyId.data) {
    throw new CompanyContextError(
      "FIXED_RUNTIME_COMPANY_MISMATCH",
      "The fixed runtime is not bound to the requested company.",
    );
  }
  return runtime;
}

/**
 * Resolves an active company without fallbacks. Role labels are deliberately
 * absent: company access is the intersection of the company and membership.
 */
export function resolveActiveCompanyContext(
  input: unknown,
  fixedRuntimeInput: unknown,
): CompanyContext {
  // Authentication, central session epoch and Directory account lifecycle are
  // revalidated upstream. This domain receives their resulting account/profile
  // identities and refuses to infer either from a local role or user row.
  const params = assertParsed(resolveCompanyContextInputSchema, input);
  const { company, membership } = params;

  if (company.id !== params.requested_company_id) {
    throw new CompanyContextError(
      "REQUESTED_COMPANY_NOT_FOUND",
      "The requested company does not match the company record.",
    );
  }
  if (
    membership.company_id !== company.id ||
    membership.central_account_id !== params.central_account_id ||
    membership.directory_profile_id !== params.directory_profile_id
  ) {
    throw new CompanyContextError(
      "COMPANY_MEMBERSHIP_MISMATCH",
      "The membership does not belong to the requested central account, directory profile and company.",
    );
  }
  if (company.status !== "ACTIVE") {
    throw new CompanyContextError(
      "COMPANY_NOT_ACTIVE",
      "The requested company is not active.",
    );
  }

  assertLiveMembership(membership);
  // The runtime binding comes from the server process configuration, never
  // from the company-selection request.
  const runtime = assertFixedRuntimeCompany(fixedRuntimeInput, company.id);
  const intersection = intersect(
    company.enabled_module_keys,
    membership.enabled_module_keys,
  );

  if (company.profile === "COMMERCIAL") {
    const commercialModules = new Set([
      "clients",
      "devis",
      "commandes-clients",
      "affaires",
      "facturation",
      "reporting-commercial",
      "fournisseurs",
      "commandes-fournisseurs",
    ]);
    const projectedCapabilities = intersect(
      company.enabled_commercial_projection_capabilities,
      membership.enabled_commercial_projection_capabilities,
    ) as CommercialProjectionCapability[];
    return Object.freeze({
      central_account_id: params.central_account_id,
      directory_profile_id: params.directory_profile_id,
      company_id: company.id,
      environment: runtime.environment,
      profile: company.profile,
      workspace: "ACCUEIL",
      module_keys: Object.freeze(
        intersection.filter((key) => commercialModules.has(key)),
      ),
      commercial_projection_capabilities: Object.freeze(projectedCapabilities),
    });
  }

  return Object.freeze({
    central_account_id: params.central_account_id,
    directory_profile_id: params.directory_profile_id,
    company_id: company.id,
    environment: runtime.environment,
    profile: company.profile,
    workspace: "INDUSTRIAL",
    module_keys: Object.freeze(intersection),
    commercial_projection_capabilities: Object.freeze([]),
  });
}

/** References are valid only in the company context that issued them. */
export function assertCompanyScopedReference(
  context: Pick<CompanyContext, "company_id">,
  referenceInput: unknown,
): CompanyScopedReference {
  const reference = assertParsed(companyScopedReferenceSchema, referenceInput);
  if (reference.company_id !== context.company_id) {
    throw new CompanyContextError(
      "COMPANY_REFERENCE_MISMATCH",
      "The reference belongs to another company.",
    );
  }
  return reference;
}

/** Requires an effective module from the company/membership intersection. */
export function assertCompanyModuleAccess(
  context: CompanyContext,
  moduleKeyInput: unknown,
): string {
  if (
    typeof moduleKeyInput !== "string" ||
    !getModuleCatalogEntry(moduleKeyInput)
  ) {
    throw new CompanyContextError(
      "COMPANY_MODULE_UNKNOWN",
      "The requested ERP module is unknown.",
    );
  }
  if (!context.module_keys.includes(moduleKeyInput)) {
    throw new CompanyContextError(
      "COMPANY_MODULE_NOT_ALLOWED",
      "The requested ERP module is not allowed for this company context.",
    );
  }
  return moduleKeyInput;
}

/** Projection capabilities are separate from write-capable stock/delivery modules. */
export function assertCommercialProjectionAccess(
  context: CompanyContext,
  capabilityInput: unknown,
): CommercialProjectionCapability {
  const parsed = z
    .enum(COMMERCIAL_PROJECTION_CAPABILITIES)
    .safeParse(capabilityInput);
  if (!parsed.success) {
    throw new CompanyContextError(
      "COMMERCIAL_PROJECTION_UNKNOWN",
      "The requested commercial projection capability is unknown.",
    );
  }
  if (context.profile !== "COMMERCIAL") {
    throw new CompanyContextError(
      "COMMERCIAL_PROJECTION_SCOPE_DENIED",
      "Commercial projections are unavailable outside a commercial company.",
    );
  }
  if (!context.commercial_projection_capabilities.includes(parsed.data)) {
    throw new CompanyContextError(
      "COMMERCIAL_PROJECTION_NOT_ALLOWED",
      "The requested commercial projection is not allowed.",
    );
  }
  return parsed.data;
}
