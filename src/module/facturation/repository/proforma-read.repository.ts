import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { proformaLineFunding, type ProformaReceiptEvidence } from "../domain/proforma-funding";
import type { ProformaPreview } from "../types/proforma.types";
import type { ProformaListQueryDTO } from "../validators/proforma.validators";
import { buildProformaPreview } from "./proforma-preview.repository";

export async function repoListProformas(query: ProformaListQueryDTO) {
  const result = await pool.query<{ items: unknown[]; total: number; as_of: string }>(`
    WITH filtered AS (SELECT p.id::text,p.reference,p.client_id,p.status,p.row_version,p.currency,
      p.created_at,p.issued_at,p.preview_payload->'company_totals' AS company_totals,
      c.client_code,c.company_name FROM public.proforma_client p JOIN public.clients c ON c.client_id=p.client_id
      WHERE ($1::text='' OR p.reference ILIKE $2 OR c.company_name ILIKE $2 OR c.client_code ILIKE $2)
        AND ($3::text IS NULL OR p.client_id=$3) AND ($4::text IS NULL OR p.status=$4)),
    page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT $5 OFFSET $6)
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id) FROM page),'[]'::jsonb) AS items,
      (SELECT count(*)::int FROM filtered) AS total,now()::text AS as_of
  `, [query.q, `%${query.q}%`, query.client_id ?? null, query.status ?? null, query.pageSize, (query.page - 1) * query.pageSize]);
  return { ...result.rows[0], page: query.page, pageSize: query.pageSize };
}

export async function repoGetProforma(id: string) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const header = (await tx.query<{ id: string; reference: string; status: string; row_version: number;
      preview_payload: ProformaPreview; issued_snapshot: Record<string, unknown> | null; created_at: string; issued_at: string | null }>(
      "SELECT id::text,reference,status,row_version,preview_payload,issued_snapshot,created_at::text,issued_at::text FROM public.proforma_client WHERE id=$1::uuid", [id])).rows[0];
    if (!header) throw new HttpError(404, "PROFORMA_NOT_FOUND", "Proforma introuvable.");
    const parts = await tx.query<{ id: string; allocation_id: string; billed_client_id: string; company_name: string;
      currency: string; required_amount: string; credits_amount: string; receipts: ProformaReceiptEvidence[] }>(`
      SELECT part.id::text,line.allocation_id::text,part.billed_client_id,part.billed_client_snapshot->>'company_name' AS company_name,
        proforma.currency,part.total_incl_tax::text AS required_amount,
        COALESCE(credits.amount,0)::numeric(18,2)::text AS credits_amount,COALESCE(receipts.items,'[]'::jsonb) AS receipts
      FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
      JOIN public.proforma_client proforma ON proforma.id=line.proforma_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',receipt.id::text,'paymentAllocationId',receipt.payment_allocation_id::text,
          'billedClientId',invoice.client_id,'currency',payment.currency,'amount',receipt.amount_ttc::text,
          'releasedAmount',COALESCE(release.amount,0)::numeric(18,2)::text,'paymentStatus',payment.status,
          'paymentWorkflowStatus',payment.workflow_status,'reversalOfId',payment.reversal_of_id,
          'depositDocumentStatus',invoice.document_status) ORDER BY receipt.created_at,receipt.id) AS items
        FROM public.proforma_deposit_sources binding
        JOIN public.proforma_receipt_assignments receipt ON receipt.deposit_source_id=binding.facture_source_allocation_id
        JOIN public.paiement_allocations allocation ON allocation.id=receipt.payment_allocation_id
        JOIN public.paiement payment ON payment.id=allocation.paiement_id
        JOIN public.facture invoice ON invoice.id=allocation.facture_id
        LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id) release ON true
        WHERE binding.proforma_billing_part_id=part.id
      ) receipts ON true
      LEFT JOIN LATERAL (
        SELECT sum(credit.amount_ttc) AS amount FROM public.proforma_deposit_sources binding
        JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
        JOIN public.avoir_source_allocations credit ON credit.facture_ligne_id=source.facture_ligne_id AND credit.allocation_status='CONSUMED'
        JOIN public.avoir note ON note.id=credit.avoir_id AND note.statut='ISSUED'
        WHERE binding.proforma_billing_part_id=part.id
      ) credits ON true
      WHERE line.proforma_id=$1::uuid ORDER BY line.allocation_id,part.billed_client_id
    `, [id]);
    const funding = parts.rows.map(part => ({ id: part.id, allocation_id: Number(part.allocation_id),
      billed_client_id: part.billed_client_id, company_name: part.company_name,
      ...proformaLineFunding({ billedClientId: part.billed_client_id, currency: part.currency, requiredAmount: part.required_amount,
        issuedCreditsAmount: part.credits_amount, receipts: part.receipts }) }));
    await tx.query("COMMIT");
    return { ...header, funding };
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
}

export async function repoPreviewExistingProforma(id: string) {
  const detail = await repoGetProforma(id);
  if (detail.status !== "DRAFT") return detail.preview_payload;
  const original = detail.preview_payload;
  return buildProformaPreview(pool, { client_id: original.client_id, currency: original.currency,
    affairs: original.affairs.map(affair => ({ allocation_id: affair.allocation_id,
      billing_parts: affair.billing_parts.map(part => ({ billed_client_id: part.billed_client_id, quantity: part.quantity })) })) }, false, id);
}
