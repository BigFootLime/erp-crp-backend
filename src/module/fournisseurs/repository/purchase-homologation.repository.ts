import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { assertGlobalPurchaseHomologation, type PurchaseHomologation } from "../domain/purchase-homologation";

export async function lockSupplierQualificationTx(tx: Pick<PoolClient, "query">, supplierId: string): Promise<boolean> {
  return Boolean((await tx.query("SELECT id FROM public.fournisseurs WHERE id=$1::uuid FOR UPDATE", [supplierId])).rows.length);
}

export async function assertSupplierPurchaseHomologationTx(tx: Pick<PoolClient, "query">, supplierId: string) {
  if (!await lockSupplierQualificationTx(tx, supplierId)) throw new HttpError(404, "FOURNISSEUR_NOT_FOUND", "Fournisseur introuvable.");
  const result = await tx.query<PurchaseHomologation & { today: string }>(`
    SELECT id::text,version,statut,valid_from::text,valid_to::text,document_id::text,
           (statement_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today
    FROM public.fournisseur_homologations
    WHERE fournisseur_id=$1::uuid AND is_current AND domaine_code IS NULL FOR SHARE`, [supplierId]);
  const decision = result.rows[0] ?? null;
  assertGlobalPurchaseHomologation(decision, decision?.today ?? "");
  return decision
    ? { scope: "GLOBAL", status: "VALID", decision }
    : { scope: "GLOBAL", status: "NOT_CONFIGURED", decision: null };
}
