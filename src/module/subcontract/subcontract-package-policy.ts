export const ACTIVE_SUBCONTRACT_ORDER_STATES = ["ENVOYEE", "ACCUSE_RECU", "PARTIELLEMENT_RECUE"];

type PackageContext = {status: string; type: string; statut_ligne: string; order_status: string};

/** Receipt completion permits closure only; it never reopens material movements. */
export function isSubcontractPackageEligible(row: PackageContext | undefined, action: "CUSTODY" | "CLOSE" = "CUSTODY"): boolean {
  return !!row && row.status === "SENT" && row.type === "SOUS_TRAITANCE" && row.statut_ligne === "ACTIVE"
    && (ACTIVE_SUBCONTRACT_ORDER_STATES.includes(row.order_status) || (action === "CLOSE" && row.order_status === "RECUE"));
}
