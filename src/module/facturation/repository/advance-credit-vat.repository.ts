import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { invoiceTypeCodeFromSnapshot } from "../domain/invoice-kind";
import { planAdvanceCreditVat, type AdvanceCreditVatSnapshot } from "../domain/advance-credit-vat";
import type { DocumentTaxBreakdown } from "../domain/document-tax-breakdown";
import { readAdvanceCreditVat } from "../domain/advance-credit-vat";
import { formatDecimal, moneyToCents } from "../domain/decimal-money";

export async function freezeAdvanceCreditVat(tx:Pick<PoolClient,"query">,invoiceId:number,credit:DocumentTaxBreakdown):Promise<AdvanceCreditVatSnapshot|undefined> {
  const original=(await tx.query<{snapshot:Record<string,unknown>;checksum:string}>(`SELECT immutable_snapshot AS snapshot,lower(document_checksum_sha256) AS checksum
    FROM public.facture WHERE id=$1`,[invoiceId])).rows[0];
  if(!original||invoiceTypeCodeFromSnapshot(original.snapshot)!==386)return undefined;
  const tax=original.snapshot.tax_breakdown as DocumentTaxBreakdown|undefined;
  if(!tax||tax.version!==1||!Array.isArray(tax.entries))throw new HttpError(409,"ADVANCE_CREDIT_VAT_INVALID","La ventilation fiscale d'origine de cet acompte doit être qualifiée.");
  const allocations=(await tx.query<{snapshot:{invoice_sha256:string;entries:Array<{tax_rate:string;tax_amount:string}>}|null}>(`
    SELECT a.advance_vat_snapshot AS snapshot FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id
    WHERE a.facture_id=$1 AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL`,[invoiceId])).rows;
  const legacy=(await tx.query<{missing:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.paiement p WHERE p.facture_id=$1 AND p.status NOT IN('REJECTED','REVERSED')
    AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=p.id)) AS missing`,[invoiceId])).rows[0];
  if(legacy?.missing||allocations.some(row=>!row.snapshot||row.snapshot.invoice_sha256!==original.checksum))throw new HttpError(409,"ADVANCE_CREDIT_VAT_INVALID","Les anciens encaissements doivent être rapprochés avant cet avoir.");
  const received=new Map<string,bigint>();
  for(const row of allocations)for(const entry of row.snapshot!.entries)received.set(entry.tax_rate,(received.get(entry.tax_rate)??0n)+moneyToCents(entry.tax_amount));
  const previous=(await tx.query<{snapshot:Record<string,unknown>;net:string;tax:string;gross:string}>(`SELECT immutable_snapshot AS snapshot,
    total_ht::text AS net,total_tax::text AS tax,total_ttc::text AS gross FROM public.avoir WHERE facture_id=$1 AND statut IN('ISSUED','emis','emise','envoyee')`,[invoiceId])).rows;
  const prior=previous.map(row=>readAdvanceCreditVat(row.snapshot?.advance_credit_vat,row.net,row.tax,row.gross));
  const applied=(await tx.query<{rate:string;net:string;tax:string}>(`SELECT line.taux_tva::numeric(8,4)::text AS rate,sum(p.amount_ex_tax)::text AS net,sum(p.tax_amount)::text AS tax
    FROM public.proforma_final_prepayments p JOIN public.facture_source_allocations original ON original.id=p.deposit_source_id
    JOIN public.facture_ligne line ON line.id=original.facture_ligne_id JOIN public.facture_source_allocations final ON final.id=p.final_source_allocation_id
    WHERE original.facture_id=$1 AND final.allocation_status IN('DRAFT','CONSUMED') GROUP BY line.taux_tva`,[invoiceId])).rows;
  return planAdvanceCreditVat({invoiceId,invoiceSha256:original.checksum,
    original:tax.entries.map(e=>({tax_rate:e.rate_percent,amount_ex_tax:e.taxable_amount,tax_amount:e.tax_amount})),
    collected:new Map([...received].map(([key,value])=>[key,formatDecimal(value,2)])),cleared:new Map(applied.map(e=>[e.rate,{net:e.net,tax:e.tax}])),prior,
    credit:credit.entries.map(e=>({tax_rate:e.rate_percent,amount_ex_tax:e.taxable_amount,tax_amount:e.tax_amount}))});
}
