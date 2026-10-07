import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { supplierContractsInstalled } from "../../../shared/commercial-terms/supplier-contract-terms.repository";
import {
  consultationSnapshotKey,
  type ConsultationTechnicalSource,
} from "../domain/supplier-consultation";
import {
  assertContractWindow,
  type ContractSnapshot,
  type ContractEvidence,
} from "../domain/supplier-open-contract";
import {
  readContractOrderSnapshotTx,
  type OrderSnapshot,
} from "./supplier-open-contract-read.repository";
import { readConsultationTechnicalSourcesTx } from "./consultation-technical.repository";
type Queryer = Pick<PoolClient, "query">;
export const CONTRACT_DOCUMENT_PROOF_SQL = `SELECT v.id FROM jsonb_array_elements($1::jsonb) ref
 JOIN public.ged_document_versions v ON v.id=(ref->>'version_id')::uuid JOIN public.ged_documents d ON d.id=v.document_id AND d.id=(ref->>'document_id')::uuid
 JOIN public.ged_blobs b ON b.id=v.blob_id AND b.sha256=ref->>'sha256' LEFT JOIN public.ged_upload_sessions u ON u.id=v.upload_session_id
 WHERE (u.scan_status IS NULL OR u.scan_status='clean') AND u.quarantine_status IS DISTINCT FROM 'quarantined' FOR SHARE OF d,v,b`;
export const CONTRACT_CALL_PROOF_SQL = `SELECT c.id::text AS call_id,c.contract_id::text,c.revision_id::text,c.technical_sources,c.documents,c.order_snapshot,
 s.reference,s.closed_at::text,r.revision,r.valid_from::text,r.valid_to::text,r.snapshot,r.evidence_snapshot AS evidence
 FROM public.supplier_open_contract_calls c JOIN public.supplier_open_contracts s ON s.id=c.contract_id
 JOIN public.supplier_open_contract_revisions r ON r.id=c.revision_id AND r.contract_id=c.contract_id WHERE c.order_id=$1::uuid`;
type CallProofRow = {
  call_id: string;
  contract_id: string;
  revision_id: string;
  reference: string;
  closed_at: string | null;
  revision: number;
  valid_from: string;
  valid_to: string;
  technical_sources: ConsultationTechnicalSource[];
  documents: Array<{
    document_id: string;
    version_id: string;
    sha256: string;
    title: string;
    code: string;
    original_name: string;
  }>;
  order_snapshot: OrderSnapshot;
  snapshot: ContractSnapshot;
  evidence: ContractEvidence;
};
export async function readSupplierOpenContractProofTx(
  tx: Queryer,
  id: string,
  enforce = false,
) {
  if (!(await supplierContractsInstalled(tx))) return null;
  const call = (await tx.query<CallProofRow>(CONTRACT_CALL_PROOF_SQL, [id]))
    .rows[0];
  if (!call) return null;
  if (enforce) {
    if (
      call.documents.length &&
      (
        await tx.query(CONTRACT_DOCUMENT_PROOF_SQL, [
          JSON.stringify(call.documents),
        ])
      ).rowCount !== call.documents.length
    )
      throw new HttpError(
        409,
        "OPEN_CONTRACT_DOCUMENT_UNAVAILABLE",
        "Un document de l’appel n’est plus disponible ou son intégrité ne peut être vérifiée.",
      );
    if (call.closed_at)
      throw new HttpError(
        409,
        "OPEN_CONTRACT_CLOSED",
        "Ce contrat est clôturé. Aucun nouvel engagement de cet appel n’est autorisé.",
      );
    const order = await readContractOrderSnapshotTx(tx, id);
    if (
      consultationSnapshotKey(order) !==
      consultationSnapshotKey(call.order_snapshot)
    )
      throw new HttpError(
        409,
        "OPEN_CONTRACT_CALL_CHANGED",
        "Les lignes de l’appel ont changé. Conservez cet historique et créez un appel corrigé.",
      );
    const sources = await readConsultationTechnicalSourcesTx(tx, id, true);
    if (
      consultationSnapshotKey(sources) !==
      consultationSnapshotKey(call.technical_sources)
    )
      throw new HttpError(
        409,
        "OPEN_CONTRACT_TECHNICAL_CHANGED",
        "Le plan, l’indice ou le périmètre OF a changé depuis l’appel. Un nouvel appel doit être préparé.",
      );
    const today = (
      await tx.query<{ today: string }>("SELECT CURRENT_DATE::text AS today")
    ).rows[0].today;
    assertContractWindow(
      call.valid_from,
      call.valid_to,
      today,
      order.lines.map((line) => line.need_date),
    );
    const evidence = await tx.query(
      `SELECT 1 FROM public.ged_document_versions v JOIN public.ged_documents d ON d.id=v.document_id JOIN public.ged_blobs b ON b.id=v.blob_id
      WHERE v.id=$1::uuid AND d.id=$2::uuid AND d.class_key='CERP_CONTRAT_FOURNISSEUR' AND b.sha256=$3 AND b.size_bytes=$4 AND b.mime_type='application/pdf'
      AND EXISTS(SELECT 1 FROM public.ged_upload_sessions u WHERE u.id=v.upload_session_id AND u.scan_status='clean' AND u.quarantine_status='released') FOR SHARE OF d,v,b`,
      [
        call.evidence.version_id,
        call.evidence.document_id,
        call.evidence.sha256,
        call.evidence.size_bytes,
      ],
    );
    if (!evidence.rowCount)
      throw new HttpError(
        409,
        "OPEN_CONTRACT_EVIDENCE_UNAVAILABLE",
        "La preuve du contrat n’est plus disponible ou son intégrité ne peut être vérifiée.",
      );
  }
  return {
    contract_id: call.contract_id,
    reference: call.reference,
    revision_id: call.revision_id,
    revision: call.revision,
    call_id: call.call_id,
    valid_from: call.valid_from,
    valid_to: call.valid_to,
    evidence: call.evidence,
    technical_sources: call.technical_sources,
    documents: call.documents,
  };
}
