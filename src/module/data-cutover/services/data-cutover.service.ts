import { CUTOVER_CATALOG, CUTOVER_CONTRIBUTABLE_DOMAINS } from "../domain/cutover-catalog";
import { repoCutoverArticleFamilies, repoCutoverFinancialStatus, repoCutoverUnits, repoGetContributorDomains, repoIsCutoverApplicationInstalled, repoIsCutoverInstalled } from "../repository/data-cutover.repository";
import type { CutoverAccess } from "../types/data-cutover.types";

export async function getCutoverCapabilities(access: CutoverAccess) {
  const installed = await repoIsCutoverInstalled();
  const applicationInstalled = installed && access.isSuperadmin ? await repoIsCutoverApplicationInstalled() : false;
  const allowed = access.isSuperadmin ? CUTOVER_CATALOG.map((domain) => domain.key) : installed ? await repoGetContributorDomains(access.userId) : [];
  const units = installed ? await repoCutoverUnits() : [];
  const families = installed && allowed.includes("ARTICLE") ? await repoCutoverArticleFamilies() : {};
  const financialCutover = installed && access.isSuperadmin ? await repoCutoverFinancialStatus() : undefined;
  return {
    phase: "PREPARATION" as const,
    strategy: "NEW_NATIVE_REMAINDER" as const,
    operational_strategy: {
      sales_orders: "NEW_NATIVE_ORDER_FOR_REMAINDER" as const,
      supplier_orders: "NEW_NATIVE_ORDER_FOR_REMAINDER" as const,
      internal_demands: "NEW_NATIVE_INTERNAL_DEMAND_FOR_REMAINDER" as const,
      existing_numbers: "HISTORICAL_REFERENCES_ONLY" as const,
      past_stock_movements: "DO_NOT_REPLAY" as const,
      past_unbilled_deliveries: "SEPARATE_FINANCIAL_RECONCILIATION" as const,
    },
    installed,
    financial_cutover: financialCutover,
    is_superadmin: access.isSuperadmin,
    can_upload: access.isSuperadmin,
    can_validate: access.isSuperadmin,
    can_read: access.isSuperadmin || allowed.length > 0,
    allowed_domains: allowed,
    contributable_domains: access.isSuperadmin ? CUTOVER_CONTRIBUTABLE_DOMAINS : [],
    posting_available: applicationInstalled,
    posting_unavailable_reason: applicationInstalled ? null : "Le chargement contrôlé nécessite ses migrations et les droits SuperAdmin. La préparation reste conservée. L'activation des compteurs est une opération distincte.",
    domains: CUTOVER_CATALOG.filter((domain) => allowed.includes(domain.key)).map((domain) => ({ ...domain, fields: domain.fields.map((field) => field.format === "unit" ? { ...field, type: "select" as const, options: units.map((unit) => unit.code) } : domain.key === "ARTICLE" && field.key === "familyCode" ? { ...field, type: "select" as const, options: [...new Set(Object.values(families).flat())], options_by_category: families, hint: "Choisir une famille CERP active de la catégorie. Une nouvelle famille se crée séparément dans Stock." } : field) })),
    numbering: {
      affair_next: null, delivery_next: null,
      proposed_affair_next: 24000, proposed_delivery_next: 15000,
      affair_example: "AFF-LIV-26-24000", delivery_example: "BL-26-15000",
      financial_shared: true, financial_shared_documents: ["FACTURE", "FACTURE_ACOMPTE", "AVOIR"],
      proforma_separate: true, active: false, next_financial_number: null, next_proforma_number: null,
      continuous_across_years: true,
    },
  };
}
