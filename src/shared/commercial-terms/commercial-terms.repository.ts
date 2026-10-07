import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { assertSupplierCallEditableTx, readSupplierContractTermsTx } from "./supplier-contract-terms.repository";
import {
  generalTermsSnapshotSchema,
  termsKind,
  type CommercialTermsScope,
  type GeneralTermsSnapshot,
} from "./commercial-terms.domain";

type Queryer = Pick<PoolClient, "query">;
export type TermsSelection = {
  id: string;
  revision: number;
  snapshot: GeneralTermsSnapshot;
  reason: string;
  created_at: string;
};
const parents = {
  devis: { table: "devis", cast: "bigint" },
  "commande-client": { table: "commande_client", cast: "bigint" },
  "commande-fournisseur": { table: "commande_fournisseur", cast: "uuid" },
} as const;

export async function lockTermsParent(
  tx: Queryer,
  scope: CommercialTermsScope,
  id: string,
): Promise<void> {
  const parent = parents[scope];
  const row = await tx.query(
    `SELECT id${scope === "commande-client" ? "" : ",statut"} FROM public.${parent.table} WHERE id=$1::${parent.cast} FOR UPDATE`,
    [id],
  );
  if (!row.rows[0])
    throw new HttpError(
      404,
      "GENERAL_TERMS_PARENT_NOT_FOUND",
      "Dossier introuvable.",
    );
  if (scope === "commande-fournisseur") await assertSupplierCallEditableTx(tx,id);
  if (scope !== "commande-client" && row.rows[0].statut !== "BROUILLON") {
    throw new HttpError(
      409,
      "GENERAL_TERMS_PARENT_LOCKED",
      "Les conditions ne peuvent être modifiées que sur un brouillon.",
    );
  }
  if (scope === "commande-client") {
    const status = await tx.query(
      `SELECT nouveau_statut FROM public.commande_historique WHERE commande_id=$1::bigint ORDER BY date_action DESC,id DESC LIMIT 1`,
      [id],
    );
    if (
      ["LIVRE", "LIVREE", "FACTURE", "ARCHIVE", "ANNULE"].includes(
        status.rows[0]?.nouveau_statut,
      )
    ) {
      throw new HttpError(
        409,
        "GENERAL_TERMS_PARENT_LOCKED",
        "Cette commande est clôturée.",
      );
    }
  }
}
export async function touchTermsParent(
  tx: Queryer,
  scope: CommercialTermsScope,
  id: string,
): Promise<void> {
  const parent = parents[scope];
  await tx.query(
    `UPDATE public.${parent.table} SET updated_at=clock_timestamp() WHERE id=$1::${parent.cast}`,
    [id],
  );
}
export async function readTermsSelection(
  tx: Queryer,
  scope: CommercialTermsScope,
  id: string,
): Promise<TermsSelection | null> {
  const result = await tx.query(
    `SELECT id::text,revision,snapshot,reason,created_at::text FROM public.commercial_general_terms_selections WHERE entity_type=$1 AND entity_id=$2 ORDER BY revision DESC LIMIT 1`,
    [scope, id],
  );
  const row = result.rows[0];
  return row
    ? { ...row, snapshot: generalTermsSnapshotSchema.parse(row.snapshot) }
    : null;
}
export async function readTermsVersion(
  tx: Queryer,
  scope: CommercialTermsScope,
  versionId: string,
  lock = false,
): Promise<GeneralTermsSnapshot | null> {
  // Upload verdict and publication are checked together; legacy untracked files
  // cannot silently become approved legal templates.
  const result = await tx.query(
    `SELECT d.id::text AS document_id,v.id::text AS version_id,d.code,d.title,
    v.version_number,v.original_name AS filename,b.sha256,b.size_bytes::int
    FROM public.ged_document_versions v JOIN public.ged_documents d ON d.id=v.document_id
    JOIN public.ged_blobs b ON b.id=v.blob_id
    WHERE v.id=$1::uuid AND d.class_key=$2 AND d.archived_at IS NULL AND v.status='APPLICABLE'
      AND b.mime_type='application/pdf'
      AND EXISTS(SELECT 1 FROM public.ged_upload_sessions s WHERE s.id=v.upload_session_id AND s.scan_status='clean' AND s.quarantine_status='released')
    ${lock ? "FOR SHARE OF v,d,b" : ""}`,
    [versionId, `CERP_${termsKind(scope)}`],
  );
  return result.rows[0]
    ? generalTermsSnapshotSchema.parse({
        ...result.rows[0],
        kind: termsKind(scope),
      })
    : null;
}
export async function hasApprovedTerms(
  tx: Queryer,
  scope: CommercialTermsScope,
): Promise<boolean> {
  const result = await tx.query(
    `SELECT EXISTS(SELECT 1 FROM public.ged_documents d JOIN public.ged_document_versions v ON v.document_id=d.id WHERE d.class_key=$1 AND d.archived_at IS NULL AND v.status='APPLICABLE') AS enabled`,
    [`CERP_${termsKind(scope)}`],
  );
  return result.rows[0]?.enabled === true;
}
export async function freezeGeneralTerms(
  tx: Queryer,
  scope: CommercialTermsScope,
  id: string,
  required: boolean,
): Promise<GeneralTermsSnapshot | null> {
  if (scope === "commande-fournisseur") {
    const inherited = await readSupplierContractTermsTx(tx,id,true);
    if (inherited) return inherited;
  }
  const selection = await readTermsSelection(tx, scope, id);
  if (!selection) {
    if (required && (await hasApprovedTerms(tx, scope)))
      throw new HttpError(
        422,
        "GENERAL_TERMS_SELECTION_REQUIRED",
        "Choisissez la version approuvée des conditions générales avant l’émission.",
      );
    return null;
  }
  const version = await readTermsVersion(
    tx,
    scope,
    selection.snapshot.version_id,
    true,
  );
  if (
    !version ||
    version.sha256 !== selection.snapshot.sha256 ||
    version.document_id !== selection.snapshot.document_id
  ) {
    if (!required) return null;
    throw new HttpError(
      409,
      "GENERAL_TERMS_VERSION_UNAVAILABLE",
      "La version des conditions générales n’est plus applicable. Choisissez une version approuvée avant l’émission.",
    );
  }
  return selection.snapshot;
}
