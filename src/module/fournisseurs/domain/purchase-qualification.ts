import { createHash } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import type { ApprovalCheck } from "./client-supplier-approval";
import {
  assertGlobalPurchaseHomologation,
  type PurchaseHomologation,
} from "./purchase-homologation";

export type PurchaseScopeLine = {
  id: string;
  position: number;
  type: string;
  catalogue_type: string | null;
  categories: string[];
};
export type QualificationDecision = PurchaseHomologation & {
  domaine_code: string | null;
  reference: string | null;
  organisme: string | null;
  perimetre: string | null;
  updated_at: string;
};
export type QualificationScope = {
  domain: string | null;
  line_ids: string[];
  decision: QualificationDecision | null;
  status: "VALID" | "NOT_CONFIGURED" | "BLOCKED";
};
export type PurchaseQualification = {
  supplier_id: string;
  checked_at: string;
  today: string;
  can_engage: boolean;
  global: QualificationScope;
  domains: QualificationScope[];
  unmapped_line_ids: string[];
  client_approvals?: ApprovalCheck[];
  lines_without_client?: string[];
};

const categoryDomains: Record<string, string> = {
  matiere_premiere: "matiere_brute",
  traitement_surface: "traitements",
  sous_traitance: "sous_traitance",
  consommable: "consommables_atelier",
};
const catalogueDomains: Record<string, string> = {
  MATIERE: "matiere_brute",
  CONSOMMABLE: "consommables_atelier",
  SOUS_TRAITANCE: "sous_traitance",
  OUTILLAGE: "outillage",
  SERVICE: "services_generaux",
};

/** Structured article categories take priority over a generic purchase-line type. */
export function purchaseLineDomains(line: PurchaseScopeLine): string[] {
  const domains = line.categories
    .map((category) => categoryDomains[category])
    .filter(Boolean);
  if (domains.length) return [...new Set(domains)].sort();
  const fallback =
    catalogueDomains[line.catalogue_type ?? ""] ??
    (
      {
        MATIERE: "matiere_brute",
        SOUS_TRAITANCE: "sous_traitance",
        PRESTATION: "services_generaux",
      } as Record<string, string>
    )[line.type];
  return fallback ? [fallback] : [];
}

export function qualificationScope(
  domain: string | null,
  lineIds: string[],
  decision: QualificationDecision | null,
  today: string,
): QualificationScope {
  const valid =
    decision?.statut === "homologue" &&
    (!decision.valid_from || decision.valid_from <= today) &&
    (!decision.valid_to || decision.valid_to >= today);
  return {
    domain,
    line_ids: lineIds,
    decision,
    status: !decision ? "NOT_CONFIGURED" : valid ? "VALID" : "BLOCKED",
  };
}

export function assertPurchaseQualification(
  state: PurchaseQualification,
): void {
  assertGlobalPurchaseHomologation(state.global.decision, state.today);
  const blocked = state.domains.filter((scope) => scope.status === "BLOCKED");
  if (blocked.length)
    throw new HttpError(
      409,
      "SUPPLIER_DOMAIN_HOMOLOGATION_NOT_VALID",
      "Une homologation du fournisseur ne permet pas cette prestation à cette date. Faites vérifier le domaine et sa validité par la Qualité.",
      { supplier_id: state.supplier_id, scopes: blocked },
    );
}

/** Exclude observation time; validity is rechecked separately at every engagement. */
export function purchaseQualificationRevision(
  state: PurchaseQualification,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        supplier_id: state.supplier_id,
        global: state.global,
        domains: state.domains,
        unmapped_line_ids: state.unmapped_line_ids,
        // Keep existing prepared documents valid when no client policy applies.
        ...(state.client_approvals?.some((check) => check.policies.length)
          ? { client_approvals: state.client_approvals }
          : {}),
      }),
    )
    .digest("hex");
}
