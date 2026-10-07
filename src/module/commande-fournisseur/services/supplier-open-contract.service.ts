import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../repository/commande-fournisseur.repository";
import { roleHasCommandeFournisseurCapability } from "../domain/commande-fournisseur-rbac";
import { repoReadSupplierOpenContracts } from "../repository/supplier-open-contract-read.repository";
import { repoCommandSupplierOpenContract } from "../repository/supplier-open-contract.repository";
import { supplierOpenContractCommandSchema } from "../domain/supplier-open-contract";
export async function readSupplierOpenContractsSVC(
  id: string,
  role: string | null | undefined,
  actorId: number,
) {
  if (
    !roleHasCommandeFournisseurCapability(role, "read") ||
    !roleHasCommandeFournisseurCapability(role, "prices")
  )
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Votre rôle ne permet pas de consulter les contrats fournisseurs.",
    );
  return repoReadSupplierOpenContracts(id, { user_id: actorId, role });
}
export async function commandSupplierOpenContractSVC(
  id: string,
  input: unknown,
  audit: AuditContext,
) {
  const parsed = supplierOpenContractCommandSchema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(
      422,
      "OPEN_CONTRACT_INPUT_INVALID",
      "Complétez les champs du contrat.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    );
  try {
    return await repoCommandSupplierOpenContract(id, parsed.data, audit);
  } catch (error) {
    if (
      (error as { code?: string; constraint?: string })?.code === "23505" &&
      (error as { constraint?: string }).constraint ===
        "supplier_open_contracts_supplier_id_reference_key"
    )
      throw new HttpError(
        409,
        "OPEN_CONTRACT_REFERENCE_EXISTS",
        "Un contrat de ce fournisseur porte déjà cette référence.",
      );
    throw error;
  }
}
