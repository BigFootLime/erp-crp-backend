import { COMMERCIAL_COMPANY_MODULE_KEYS } from "../module/entreprises/domain/company-context";
import { HttpError } from "../utils/httpError";

export type ApprovedCompanyAccess = Readonly<{
  company_id: string;
  expected_membership_version: number;
}>;
export type CompanyAccessCeiling = Readonly<{
  company_id: string;
  code: string;
  name: string;
  profile: "COMMERCIAL" | "INDUSTRIAL";
  status: string;
  enabled_module_keys: readonly string[];
  enabled_commercial_projection_capabilities: readonly string[];
  membership_version: number;
}>;
export type DerivedCompanyAccess = Readonly<{
  company_id: string;
  code: string;
  name: string;
  profile: "COMMERCIAL" | "INDUSTRIAL";
  allowed_module_keys: string[];
  enabled_commercial_projection_capabilities: string[];
}>;

/**
 * Account approval is the only module decision.  Selecting a company never
 * introduces a second, client-controlled ACL matrix.
 */
export function deriveApprovedCompanyAccess(
  approvedModules: readonly string[],
  selections: readonly ApprovedCompanyAccess[],
  ceilings: readonly CompanyAccessCeiling[],
): DerivedCompanyAccess[] {
  const byId = new Map(ceilings.map((company) => [company.company_id, company]));
  const commercial = new Set<string>(COMMERCIAL_COMPANY_MODULE_KEYS);
  return selections.map((selection) => {
    const company = byId.get(selection.company_id);
    if (!company || company.status !== "ACTIVE")
      throw new HttpError(422, "ACCOUNT_REQUEST_COMPANY_UNAVAILABLE", "Cette entreprise n’est pas disponible.");
    if (company.membership_version !== selection.expected_membership_version)
      throw new HttpError(409, "ACCOUNT_REQUEST_COMPANY_MEMBERSHIP_CONFLICT", "Le rattachement entreprise a changé. Rechargez la validation.");
    const ceiling = new Set(company.enabled_module_keys);
    const allowed_module_keys = [...new Set(approvedModules)]
      .filter((key) => ceiling.has(key))
      .filter((key) => company.profile !== "COMMERCIAL" || commercial.has(key))
      .sort();
    return {
      company_id: company.company_id,
      code: company.code,
      name: company.name,
      profile: company.profile,
      allowed_module_keys,
      enabled_commercial_projection_capabilities: [...company.enabled_commercial_projection_capabilities].sort(),
    };
  });
}
