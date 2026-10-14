import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { computeExactLineTotals,moneyToCents } from "../domain/decimal-money";
import type { FacturePreviewLine } from "../types/workflow.types";
import type { FacturePreviewBodyDTO } from "../validators/workflow.validators";

type Queryer=Pick<PoolClient,"query">;
export type ProformaDepositSource={source_id:string;source_line_id:string;proforma_reference:string;status:string;
  billed_client_id:string;currency:string;quantity:string;total_ex_tax:string;total_incl_tax:string;tax_rate_percent:string;
  source_revision:string;designation:string;code_piece:string|null;commande_id:string;affaire_id:string;
  already_ex_tax:string;already_incl_tax:string;customer_blocked:boolean;proforma_part_snapshot:Record<string,unknown>};

export async function readProformaDepositInvoiceSources(tx:Queryer,ids:readonly string[],lock:boolean,ownInvoiceId?:number):Promise<ProformaDepositSource[]> {
  if(!ids.length)return[];
  if(lock) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('delivery-prepayment-binding',0))");
    await tx.query(`SELECT part.id FROM public.proforma_billing_parts part WHERE part.id=ANY($1::uuid[]) ORDER BY part.id FOR UPDATE`,[[...ids].sort()]);
  }
  const result=await tx.query<ProformaDepositSource>(`SELECT proforma.id::text AS source_id,part.id::text AS source_line_id,
    proforma.reference AS proforma_reference,proforma.status,part.billed_client_id,proforma.currency,part.quantity::text,
    part.total_ex_tax::text,part.total_incl_tax::text,part.tax_rate_percent::text,line.source_revision,
    line.source_snapshot->>'designation' AS designation,line.source_snapshot->>'code_piece' AS code_piece,
    line.source_snapshot->>'commande_id' AS commande_id,line.source_snapshot->>'livraison_affaire_id' AS affaire_id,
    COALESCE(customer.blocked,false) AS customer_blocked,to_jsonb(part) AS proforma_part_snapshot,
    COALESCE(used.ex_tax,0)::numeric(18,2)::text AS already_ex_tax,COALESCE(used.incl_tax,0)::numeric(18,2)::text AS already_incl_tax
    FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
    JOIN public.proforma_client proforma ON proforma.id=line.proforma_id JOIN public.clients customer ON customer.client_id=part.billed_client_id
    LEFT JOIN LATERAL (SELECT sum(source.amount_ex_tax) AS ex_tax,sum(source.amount_incl_tax) AS incl_tax FROM public.facture_source_allocations source
      WHERE source.source_type='DEPOSIT' AND source.source_line_id=part.id::text AND source.allocation_status IN ('DRAFT','CONSUMED')
        AND ($2::bigint IS NULL OR source.facture_id<>$2)) used ON true
    WHERE part.id=ANY($1::uuid[]) ORDER BY part.id`,[[...ids].sort(),ownInvoiceId??null]);
  return result.rows;
}

export function buildProformaDepositInvoiceLine(source:ProformaDepositSource,selection:FacturePreviewBodyDTO['sources'][number],clientId:string,currency:string):FacturePreviewLine {
  if(source.source_id!==selection.source_id || source.source_line_id!==selection.source_line_id || source.status!=='ISSUED')throw new HttpError(409,"PROFORMA_DEPOSIT_SOURCE_UNAVAILABLE","Sélectionnez une ligne de proforma émise.");
  if(source.billed_client_id!==clientId || source.currency!==currency || source.customer_blocked)throw new HttpError(409,"PROFORMA_DEPOSIT_PARTY_MISMATCH","L'acompte doit être facturé à la société et dans la devise de la proforma.");
  const amount=selection.advance_amount_ex_tax;
  if(!amount)throw new HttpError(422,"PROFORMA_DEPOSIT_AMOUNT_REQUIRED","Choisissez le montant d'acompte HT.");
  const exact=computeExactLineTotals({quantity:'1.000',unitPriceExTax:amount,discountPercent:'0.0000',taxRatePercent:source.tax_rate_percent});
  if(moneyToCents(exact.totalExTax)<=0n || moneyToCents(exact.totalExTax)+moneyToCents(source.already_ex_tax)>moneyToCents(source.total_ex_tax)
    || moneyToCents(exact.totalInclTax)+moneyToCents(source.already_incl_tax)>moneyToCents(source.total_incl_tax)) {
    throw new HttpError(409,"PROFORMA_DEPOSIT_AMOUNT_EXCEEDED","Le montant dépasse le solde d'acompte disponible pour cette affaire.");
  }
  return {source_type:'DEPOSIT',source_id:source.source_id,source_line_id:source.source_line_id,
    designation:`Acompte ${source.proforma_reference} — ${source.designation}`,code_piece:source.code_piece,quantity:'1.000',unit:'acompte',
    unit_price_ex_tax:amount,discount_percent:'0.0000',tax_rate_percent:source.tax_rate_percent,
    total_ex_tax:exact.totalExTax,tax_amount:exact.taxAmount,total_incl_tax:exact.totalInclTax,
    pricing_version:source.source_revision,rule_code:'PROFORMA_DEPOSIT_V1'};
}

export async function bindProformaDepositInvoiceSourceTx(tx:PoolClient,args:{sourceAllocationId:string;partId:string;actorId:number;correlationId:string}):Promise<void> {
  await tx.query(`INSERT INTO public.proforma_deposit_sources(facture_source_allocation_id,proforma_billing_part_id,created_by,correlation_id)
    VALUES($1::uuid,$2::uuid,$3,$4::uuid)`,[args.sourceAllocationId,args.partId,args.actorId,args.correlationId]);
}
