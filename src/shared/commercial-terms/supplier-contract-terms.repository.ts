import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import {
  generalTermsSnapshotSchema,
  type GeneralTermsSnapshot,
} from "./commercial-terms.domain";

type Queryer = Pick<PoolClient, "query">;
export async function supplierContractsInstalled(
  tx: Queryer,
): Promise<boolean> {
  return (
    (
      await tx.query(
        "SELECT to_regclass('public.supplier_open_contract_calls') IS NOT NULL AS enabled",
      )
    ).rows[0]?.enabled === true
  );
}
export async function assertSupplierCallEditableTx(
  tx: Queryer,
  id: string,
): Promise<void> {
  if (
    (await supplierContractsInstalled(tx)) &&
    (
      await tx.query(
        "SELECT 1 FROM public.supplier_open_contract_calls WHERE order_id=$1::uuid",
        [id],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "OPEN_CONTRACT_CALL_SEALED",
      "Cet appel conserve ses lignes et ses conditions d’origine. Annulez la commande puis créez un nouvel appel pour une correction commerciale.",
    );
}
export async function supplierOrderIsContractCallTx(
  tx: Queryer,
  id: string,
): Promise<boolean> {
  return (
    (await supplierContractsInstalled(tx)) &&
    Boolean(
      (
        await tx.query(
          "SELECT 1 FROM public.supplier_open_contract_calls WHERE order_id=$1::uuid",
          [id],
        )
      ).rowCount,
    )
  );
}
export const CONTRACT_TERMS_SQL = `SELECT r.snapshot->'general_terms' AS snapshot FROM public.supplier_open_contract_calls c
 JOIN public.supplier_open_contract_revisions r ON r.id=c.revision_id AND r.contract_id=c.contract_id WHERE c.order_id=$1::uuid`;
export async function readSupplierContractTermsTx(
  tx: Queryer,
  id: string,
  lock = false,
): Promise<GeneralTermsSnapshot | null> {
  if (!(await supplierContractsInstalled(tx))) return null;
  const row = (await tx.query(CONTRACT_TERMS_SQL, [id])).rows[0];
  if (!row) return null;
  const terms = generalTermsSnapshotSchema.parse(row.snapshot);
  // Past approved terms belong to this immutable call, even if a newer CGA is published.
  // Integrity and quarantine remain mandatory; no arbitrary client-supplied version is accepted.
  const proof = await tx.query(
    `SELECT 1 FROM public.ged_document_versions v JOIN public.ged_documents d ON d.id=v.document_id JOIN public.ged_blobs b ON b.id=v.blob_id
    WHERE v.id=$1::uuid AND d.id=$2::uuid AND d.class_key='CERP_CGA' AND b.sha256=$3 AND b.size_bytes=$4 AND b.mime_type='application/pdf'
    AND EXISTS(SELECT 1 FROM public.ged_upload_sessions u WHERE u.id=v.upload_session_id AND u.scan_status='clean' AND u.quarantine_status='released')
    ${lock ? "FOR SHARE OF d,v,b" : ""}`,
    [terms.version_id, terms.document_id, terms.sha256, terms.size_bytes],
  );
  if (!proof.rowCount)
    throw new HttpError(
      409,
      "OPEN_CONTRACT_TERMS_UNAVAILABLE",
      "Le fichier des CGA convenues n’est plus disponible ou son intégrité ne peut être vérifiée.",
    );
  return terms;
}
