import type { PoolClient } from "pg";
import { readConsultationDocuments } from "./consultation-documents.repository";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { supplierContractsInstalled } from "../../../shared/commercial-terms/supplier-contract-terms.repository";
import type {
  ContractCall,
  ContractEvidence,
  ContractRevision,
  ContractUsage,
  ContractItem,
  ContractSnapshot,
} from "../domain/supplier-open-contract";
type Queryer = Pick<PoolClient, "query">;
export type OrderLine = Omit<ContractItem, "key" | "limit"> & {
  id: string;
  quantity: number;
  need_date: string | null;
};
export type OrderSnapshot = Omit<
  ContractSnapshot,
  "general_terms" | "items"
> & { supplier_id: string; lines: OrderLine[] };
export const CONTRACT_ORDER_HEADER_SQL = `SELECT fournisseur_id::text AS supplier_id,devise AS currency,incoterm,conditions_paiement AS payment_terms,mode_transport AS transport_mode FROM public.commande_fournisseur WHERE id=$1::uuid`;
export const CONTRACT_ORDER_LINES_SQL = `SELECT l.id::text,l.article_id::text,l.designation,l.type,l.unite AS unit,l.unite_stock AS stock_unit,l.coef_conversion::float8 AS coefficient,
 l.quantite::float8 AS quantity,l.prix_unitaire_ht::float8 AS unit_price_ht,l.remise_pct::float8 AS discount_pct,l.frais_ht::float8 AS fees_ht,l.tva_pct::float8 AS vat_pct,
 l.reference_fournisseur AS supplier_reference,l.exigences_qualite AS requirements,l.documents_attendus AS documents,COALESCE(l.date_besoin,cf.date_besoin)::text AS need_date
 FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur cf ON cf.id=l.commande_id WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE' ORDER BY l.position,l.id`;
export async function readContractOrderSnapshotTx(
  tx: Queryer,
  id: string,
): Promise<OrderSnapshot> {
  const header = (
    await tx.query<Omit<OrderSnapshot, "lines">>(CONTRACT_ORDER_HEADER_SQL, [
      id,
    ])
  ).rows[0];
  if (!header)
    throw new HttpError(
      404,
      "COMMANDE_FOURNISSEUR_NOT_FOUND",
      "Commande fournisseur introuvable.",
    );
  return {
    ...header,
    lines: (await tx.query<OrderLine>(CONTRACT_ORDER_LINES_SQL, [id])).rows,
  };
}
export const CONTRACT_EVIDENCE_SQL = `SELECT d.id::text AS document_id,v.id::text AS version_id,d.code,d.title,
 v.version_number,v.original_name AS filename,b.sha256,b.size_bytes::int FROM public.ged_document_versions v
 JOIN public.ged_documents d ON d.id=v.document_id JOIN public.ged_blobs b ON b.id=v.blob_id
 WHERE d.class_key='CERP_CONTRAT_FOURNISSEUR' AND d.archived_at IS NULL AND v.status='APPLICABLE' AND b.mime_type='application/pdf'
 AND EXISTS(SELECT 1 FROM public.ged_upload_sessions u WHERE u.id=v.upload_session_id AND u.scan_status='clean' AND u.quarantine_status='released')
 AND (SELECT count(*) FROM public.ged_document_links l WHERE l.document_id=d.id)=1
 AND EXISTS(SELECT 1 FROM public.ged_document_links l WHERE l.document_id=d.id AND l.entity_type='FOURNISSEUR' AND l.entity_id=$1)
 AND ($2::uuid IS NULL OR v.id=$2::uuid)`;
export const CONTRACT_REVISION_SQL = `SELECT id::text,revision,valid_from::text,valid_to::text,snapshot,evidence_snapshot AS evidence,reason,created_at::text
 FROM public.supplier_open_contract_revisions WHERE contract_id=$1::uuid ORDER BY revision DESC`;
export const CONTRACT_USAGE_SQL = `WITH receipts AS (
 SELECT commande_fournisseur_ligne_id AS line_id,sum(qty_received) AS received FROM public.reception_fournisseur_lignes GROUP BY commande_fournisseur_ligne_id
 ), amounts AS (
 SELECT m.contract_line_id,cf.statut,COALESCE(p.received,0) AS received,
   CASE WHEN cf.statut='ANNULEE' THEN 0 ELSE greatest(COALESCE(p.received,0),m.quantity-l.qty_annulee) END AS committed
 FROM public.supplier_open_contract_calls c JOIN public.supplier_open_contract_call_lines m ON m.call_id=c.id
 JOIN public.commande_fournisseur cf ON cf.id=c.order_id JOIN public.commande_fournisseur_ligne l ON l.id=m.line_id
 LEFT JOIN receipts p ON p.line_id=m.line_id WHERE c.contract_id=$1::uuid
 ) SELECT contract_line_id::text AS key,
 COALESCE(sum(committed) FILTER(WHERE statut IN ('BROUILLON','A_VALIDER')),0)::float8 AS reserved,
 COALESCE(sum(committed) FILTER(WHERE statut NOT IN ('BROUILLON','A_VALIDER','ANNULEE')),0)::float8 AS ordered,
 sum(received)::float8 AS received,sum(committed)::float8 AS committed FROM amounts GROUP BY contract_line_id`;
export async function readContractRevisionTx(
  tx: Queryer,
  id: string,
): Promise<ContractRevision | null> {
  return (
    (await tx.query<ContractRevision>(`${CONTRACT_REVISION_SQL} LIMIT 1`, [id]))
      .rows[0] ?? null
  );
}
export async function readContractUsageTx(
  tx: Queryer,
  id: string,
  revision: ContractRevision,
): Promise<ContractUsage[]> {
  const rows = (
    await tx.query<Omit<ContractUsage, "remaining">>(CONTRACT_USAGE_SQL, [id])
  ).rows;
  return revision.snapshot.items.map((item) => {
    const usage = rows.find((row) => row.key === item.key) ?? {
      key: item.key,
      reserved: 0,
      ordered: 0,
      received: 0,
      committed: 0,
    };
    return {
      ...usage,
      remaining: Math.max(
        0,
        Math.round((item.limit - usage.committed) * 1000) / 1000,
      ),
    };
  });
}
export async function repoReadSupplierOpenContracts(
  orderId: string,
  actor: { user_id: number; role?: string | null },
) {
  const order = (
    await db.query(
      "SELECT fournisseur_id::text AS supplier_id FROM public.commande_fournisseur WHERE id=$1::uuid",
      [orderId],
    )
  ).rows[0];
  if (!order)
    throw new HttpError(
      404,
      "COMMANDE_FOURNISSEUR_NOT_FOUND",
      "Commande fournisseur introuvable.",
    );
  if (!(await supplierContractsInstalled(db)))
    return {
      enabled: false,
      call: null,
      contracts: [],
      evidence_choices: [],
      available_documents: [],
    };
  const call =
    (
      await db.query<{ contract_id: string; revision_id: string; id: string }>(
        "SELECT id::text,contract_id::text,revision_id::text FROM public.supplier_open_contract_calls WHERE order_id=$1::uuid",
        [orderId],
      )
    ).rows[0] ?? null;
  const headers = (
    await db.query<{
      id: string;
      reference: string;
      closed_at: string | null;
      close_reason: string | null;
    }>(
      "SELECT id::text,reference,closed_at::text,close_reason FROM public.supplier_open_contracts WHERE supplier_id=$1::uuid ORDER BY (id=$2::uuid) DESC NULLS LAST,created_at DESC LIMIT 100",
      [order.supplier_id, call?.contract_id ?? null],
    )
  ).rows;
  const contracts = [];
  for (const header of headers) {
    const revisions = (
      await db.query<ContractRevision>(CONTRACT_REVISION_SQL, [header.id])
    ).rows;
    const current = revisions[0];
    if (!current) continue;
    const calls = (
      await db.query<ContractCall>(
        `SELECT c.id::text,c.order_id::text,cf.code AS order_code,cf.statut AS status,c.revision_id::text,c.created_at::text,c.technical_sources,c.documents
      FROM public.supplier_open_contract_calls c JOIN public.commande_fournisseur cf ON cf.id=c.order_id WHERE c.contract_id=$1::uuid ORDER BY (c.order_id=$2::uuid) DESC,c.created_at DESC LIMIT 201`,
        [header.id, orderId],
      )
    ).rows;
    contracts.push({
      ...header,
      current,
      revisions,
      usage: await readContractUsageTx(db, header.id, current),
      calls,
    });
  }
  const evidenceChoices = (
    await db.query<ContractEvidence>(
      CONTRACT_EVIDENCE_SQL +
        " ORDER BY d.code,v.version_number DESC LIMIT 100",
      [order.supplier_id, null],
    )
  ).rows;
  return {
    enabled: true,
    call,
    contracts,
    evidence_choices: evidenceChoices,
    available_documents: call
      ? []
      : await readConsultationDocuments(db, orderId, actor),
  };
}
