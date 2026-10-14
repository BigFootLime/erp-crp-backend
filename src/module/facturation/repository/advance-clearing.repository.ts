import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { readAdvanceClearing, type AdvanceClearingSnapshot } from "../domain/advance-clearing";
import { moneyToCents } from "../domain/decimal-money";

/** Freeze settlement facts before issuance, under the shared financial evidence lock. */
export async function freezeAdvanceClearing(tx: Pick<PoolClient, "query">, invoiceId: number, paid: string): Promise<AdvanceClearingSnapshot | undefined> {
  if (moneyToCents(paid) === 0n) return undefined;
  const rows = (await tx.query<AdvanceClearingSnapshot["entries"][number] & { qualified: boolean }>(`
    SELECT advance.id::int AS deposit_invoice_id,lower(advance.document_checksum_sha256) AS deposit_invoice_sha256,
      receipt.payment_allocation_id::text,payments.deposit_source_id::text,line.taux_tva::text AS tax_rate,
      sum(payments.amount_ex_tax)::numeric(18,2)::text AS amount_ex_tax,sum(payments.tax_amount)::numeric(18,2)::text AS tax_amount,
      sum(payments.amount_ttc)::numeric(18,2)::text AS amount_incl_tax,
      bool_and(advance.immutable_snapshot->>'invoice_type_code'='386' AND allocation.advance_vat_snapshot IS NOT NULL
        AND allocation.advance_vat_snapshot->>'invoice_sha256'=lower(advance.document_checksum_sha256)) AS qualified
    FROM public.proforma_final_prepayments payments JOIN public.facture_source_allocations final ON final.id=payments.final_source_allocation_id
    JOIN public.facture_source_allocations source ON source.id=payments.deposit_source_id JOIN public.facture advance ON advance.id=source.facture_id
    JOIN public.facture_ligne line ON line.id=source.facture_ligne_id
    JOIN public.proforma_receipt_assignments receipt ON receipt.id=payments.receipt_assignment_id
    JOIN public.paiement_allocations allocation ON allocation.id=receipt.payment_allocation_id
    WHERE final.facture_id=$1 AND final.allocation_status IN('DRAFT','CONSUMED')
    GROUP BY advance.id,receipt.payment_allocation_id,payments.deposit_source_id,line.taux_tva`, [invoiceId])).rows;
  if (!rows.length || rows.some(row => !row.qualified)) throw new HttpError(409, "ADVANCE_CLEARING_EVIDENCE_INVALID", "Les encaissements d'origine doivent être qualifiés avant l'émission de cette facture.");
  const limits = (await tx.query<{ excess: boolean }>(`
    WITH used AS (
      SELECT original.facture_id,line.taux_tva AS rate,sum(applied.tax_amount) AS tax
      FROM public.proforma_final_prepayments applied JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
      JOIN public.facture_source_allocations original ON original.id=applied.deposit_source_id JOIN public.facture_ligne line ON line.id=original.facture_ligne_id
      WHERE (final.allocation_status='CONSUMED' OR final.facture_id=$1)
        AND original.facture_id=ANY($2::bigint[]) GROUP BY original.facture_id,line.taux_tva
    ), cash AS (
      SELECT allocation.facture_id,(e->>'tax_rate')::numeric AS rate,sum((e->>'tax_amount')::numeric) AS tax
      FROM public.paiement_allocations allocation JOIN public.paiement payment ON payment.id=allocation.paiement_id,
        LATERAL jsonb_array_elements(allocation.advance_vat_snapshot->'entries') e
      WHERE allocation.facture_id=ANY($2::bigint[]) AND payment.status NOT IN('REJECTED','REVERSED')
        AND payment.workflow_status<>'REVERSED' AND payment.reversal_of_id IS NULL
      GROUP BY allocation.facture_id,(e->>'tax_rate')::numeric
    ) SELECT EXISTS(SELECT 1 FROM used LEFT JOIN cash USING(facture_id,rate) WHERE used.tax>COALESCE(cash.tax,0)) AS excess`,
    [invoiceId,[...new Set(rows.map(row => row.deposit_invoice_id))]])).rows[0];
  if (limits?.excess) throw new HttpError(409, "ADVANCE_CLEARING_VAT_EXCEEDED", "La TVA reprise dépasse la TVA réellement encaissée sur les acomptes.");
  return readAdvanceClearing({ version: 1, amount_incl_tax: paid, entries: rows.map(({ qualified: _qualified, ...entry }) => entry) }, paid);
}
