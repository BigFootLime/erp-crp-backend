import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { invoiceTypeCodeFromSnapshot } from "../domain/invoice-kind";
import { planAdvanceVat, type AdvanceVatSnapshot } from "../domain/advance-vat";
import { moneyToCents } from "../domain/decimal-money";
import { documentTaxBreakdownFromSnapshot } from "../domain/document-tax-breakdown";

type AdvanceInvoiceFacts = {
  fiscal_snapshot: Record<string, unknown> | null; immutable_checksum: string; has_deposit_sources: boolean;
  total_ex_tax: string; total_tax: string; total_incl_tax: string;
  tax_breakdown: Array<{ tax_rate: string; total_ex_tax: string; tax_amount: string }>;
};

/** Caller already holds the invoice lock; this runs before inserting the allocation. */
export async function freezeAdvanceVat(tx: Pick<PoolClient, "query">, args: {
  invoiceId: number; paymentId: number; amount: string;
}): Promise<AdvanceVatSnapshot | null> {
  const invoice = (await tx.query<AdvanceInvoiceFacts>(`
    SELECT 'INVOICE'::text AS source_type, f.id::text AS source_id, COALESCE(f.legal_number,f.numero) AS source_number,
      f.immutable_snapshot AS fiscal_snapshot, lower(f.document_checksum_sha256) AS immutable_checksum,
      f.total_ht::text AS total_ex_tax, COALESCE(f.total_tax,f.total_ttc-f.total_ht)::text AS total_tax, f.total_ttc::text AS total_incl_tax,
      f.immutable_snapshot->'tax_breakdown' AS tax_snapshot, COALESCE(f.immutable_snapshot ? 'tax_breakdown',false) AS tax_snapshot_present,
      EXISTS(SELECT 1 FROM public.facture_source_allocations WHERE facture_id=f.id AND source_type='DEPOSIT') AS has_deposit_sources,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('tax_rate',rate,'total_ex_tax',net,'tax_amount',tax) ORDER BY rate)
        FROM (SELECT taux_tva::text AS rate,sum(total_ht)::text AS net,sum(COALESCE(tax_amount,total_ttc-total_ht))::text AS tax
          FROM public.facture_ligne WHERE facture_id=f.id GROUP BY taux_tva) groups),'[]'::jsonb) AS tax_breakdown
    FROM public.facture f WHERE f.id=$1`, [args.invoiceId])).rows[0];
  if (!invoice) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
  const kind = invoiceTypeCodeFromSnapshot(invoice.fiscal_snapshot);
  if (kind !== 386) {
    if (invoice.has_deposit_sources) throw new HttpError(409, "ADVANCE_INVOICE_KIND_UNQUALIFIED", "Le type fiscal de cette facture d’acompte doit être vérifié.");
    return null;
  }
  if (!invoice.fiscal_snapshot?.tax_breakdown) throw new HttpError(409, "ADVANCE_VAT_HISTORY_UNQUALIFIED", "La ventilation fiscale figée de cet ancien acompte doit être qualifiée.");
  const tax = documentTaxBreakdownFromSnapshot({ snapshot: invoice.fiscal_snapshot,
    lines: invoice.tax_breakdown.map(group => ({ ratePercent: group.tax_rate, net: group.total_ex_tax, tax: group.tax_amount })),
    totalExTax: invoice.total_ex_tax, totalTax: invoice.total_tax, totalInclTax: invoice.total_incl_tax });
  const prior = (await tx.query<{ amount: string; snapshot: AdvanceVatSnapshot | null }>(`
    SELECT a.amount_ttc::text AS amount,a.advance_vat_snapshot AS snapshot
    FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id
    WHERE a.facture_id=$1 AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL`, [args.invoiceId])).rows;
  const other = (await tx.query<{ legacy: string; credits: string }>(`
    SELECT COALESCE((SELECT sum(p.montant) FROM public.paiement p WHERE p.facture_id=$1 AND p.id<>$2
      AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=p.id)),0)::text AS legacy,
      COALESCE((SELECT sum(total_ttc) FROM public.avoir WHERE facture_id=$1 AND statut IN('ISSUED','emis','emise','envoyee')),0)::text AS credits`,
    [args.invoiceId,args.paymentId])).rows[0];
  if (moneyToCents(other?.legacy ?? "0") !== 0n || moneyToCents(other?.credits ?? "0") !== 0n
    || prior.some(row => !row.snapshot || moneyToCents(row.amount) !== moneyToCents(row.snapshot.allocation_amount))) {
    throw new HttpError(409, "ADVANCE_VAT_HISTORY_UNQUALIFIED", "Les anciens encaissements ou avoirs de cet acompte nécessitent un rapprochement de TVA.");
  }
  return planAdvanceVat({ invoiceId: args.invoiceId, invoiceSha256: invoice.immutable_checksum,
    invoiceGross: invoice.total_incl_tax, allocationAmount: args.amount,
    originalTax: tax.entries.map(group => ({ tax_rate: group.rate_percent, tax_amount: group.tax_amount })),
    prior: prior.map(row => row.snapshot!) });
}
