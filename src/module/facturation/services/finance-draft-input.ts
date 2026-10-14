import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { documentTaxBreakdownFromSnapshot } from "../domain/document-tax-breakdown";
import { readSavedFinalInvoicePrepayments } from "../repository/final-invoice-prepayments.repository";
import { isInvoiceIssuedForSettlement } from "../domain/finance-policy";
import type { FinanceDocumentInput,FinanceDocumentLine,FinanceParty } from "./finance-document-render";

type DraftRow = {
  number:string;
  issue_date:string;
  document_status:string|null;
  legacy_status:string;
  currency:string;
  invoice_type_code:380|386|null;
  client:FinanceParty;
  immutable_snapshot:unknown;
  total_ex_tax:string;
  total_tax:string;
  total_incl_tax:string;
  discount_percent:string;
  lines:FinanceDocumentLine[];
  due_dates:FinanceDocumentInput["dueDates"];
  fallback_due_date:string|null;
  customer_text:string|null;
  reason:string|null;
  reason_code:string|null;
  corrected_invoice:string|null;
  original_global_discount_percent:string|null;
};

/** Exact values from one repeatable snapshot; tables are a closed internal choice. */
export async function readFinanceDraftInput(tx:Pick<PoolClient,"query">,kind:"FACTURE"|"AVOIR",id:number):Promise<Omit<FinanceDocumentInput,"issuer">>{
  if(!Number.isSafeInteger(id)||id<=0||(kind!=="FACTURE"&&kind!=="AVOIR"))
    throw new HttpError(422,"FINANCE_DOCUMENT_CONTEXT_INVALID","Le document financier doit être sélectionné.");
  const invoice=kind==="FACTURE",table=invoice?"facture":"avoir",lineTable=invoice?"facture_ligne":"avoir_ligne",parent=invoice?"facture_id":"avoir_id";
  const result=await tx.query<DraftRow>(`SELECT record.numero AS number,
    COALESCE(record.date_emission,(now() AT TIME ZONE 'Europe/Paris')::date)::text AS issue_date,
    ${invoice?"record.document_status":"NULL::text"} AS document_status,record.statut AS legacy_status,
    COALESCE(record.currency,'EUR') AS currency,record.immutable_snapshot,
    ${invoice?`CASE WHEN EXISTS(SELECT 1 FROM public.facture_source_allocations WHERE facture_id=record.id AND source_type='DEPOSIT')
      AND NOT EXISTS(SELECT 1 FROM public.facture_source_allocations WHERE facture_id=record.id AND source_type<>'DEPOSIT') THEN 386 ELSE 380 END`:"NULL::integer"} AS invoice_type_code,
    CASE WHEN record.client_snapshot IS NULL OR record.client_snapshot='{}'::jsonb
      THEN jsonb_build_object('company_name',customer.company_name) ELSE record.client_snapshot END AS client,
    record.total_ht::numeric(18,2)::text AS total_ex_tax,
    COALESCE(record.total_tax,record.total_ttc-record.total_ht)::numeric(18,2)::text AS total_tax,
    record.total_ttc::numeric(18,2)::text AS total_incl_tax,
    ${invoice?"COALESCE(record.remise_globale,0)::numeric(9,4)::text":"'0.0000'::text"} AS discount_percent,
    ${invoice?"record.customer_text":"NULL::text"} AS customer_text,
    ${invoice?"NULL::text":"record.motif"} AS reason,${invoice?"NULL::text":"record.reason_code"} AS reason_code,
    ${invoice?"NULL::text":"(SELECT COALESCE(legal_number,numero) FROM public.facture WHERE id=record.facture_id)"} AS corrected_invoice,
    ${invoice?"NULL::text":"(SELECT COALESCE(immutable_snapshot->'totals'->>'global_discount_percent',remise_globale::numeric(9,4)::text,'0.0000') FROM public.facture WHERE id=record.facture_id)"} AS original_global_discount_percent,
    ${invoice?"record.date_echeance::text":"NULL::text"} AS fallback_due_date,
    ${invoice?`COALESCE((SELECT jsonb_agg(jsonb_build_object('dueDate',due.due_date::text,'label',due.label,'amount',due.amount_due::numeric(18,2)::text)
      ORDER BY due.due_date,due.id) FROM public.facture_echeance due WHERE due.facture_id=record.id),'[]'::jsonb)`:"'[]'::jsonb"} AS due_dates,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('designation',line.designation,'codePiece',line.code_piece,
      'quantity',line.quantite::numeric(18,3)::text,'unit',line.unite,'unitPriceExTax',line.prix_unitaire_ht::numeric(18,4)::text,
      'discountPercent',COALESCE(line.remise_ligne,0)::numeric(9,4)::text,'taxRatePercent',COALESCE(line.taux_tva,0)::numeric(9,4)::text,
      'totalExTax',line.total_ht::numeric(18,2)::text,'taxAmount',COALESCE(line.tax_amount,line.total_ttc-line.total_ht)::numeric(18,2)::text,
      'totalInclTax',line.total_ttc::numeric(18,2)::text) ORDER BY line.ordre,line.id)
      FROM public.${lineTable} line WHERE line.${parent}=record.id),'[]'::jsonb) AS lines
    FROM public.${table} record LEFT JOIN public.clients customer ON customer.client_id=record.client_id WHERE record.id=$1`,[id]);
  const row=result.rows[0];
  if(!row)throw new HttpError(404,invoice?"FACTURE_NOT_FOUND":"AVOIR_NOT_FOUND","Document financier introuvable.");
  if(isInvoiceIssuedForSettlement({documentStatus:row.document_status,legacyStatus:row.legacy_status}))
    throw new HttpError(409,invoice?"FACTURE_DOCUMENT_IMMUTABLE":"AVOIR_DOCUMENT_IMMUTABLE","Le PDF émis doit être relu dans ses archives ; il ne peut pas être régénéré.");
  const tax=documentTaxBreakdownFromSnapshot({snapshot:row.immutable_snapshot,
    lines:row.lines.map(line=>({ratePercent:line.taxRatePercent,net:line.totalExTax,tax:line.taxAmount})),
    totalExTax:row.total_ex_tax,totalTax:row.total_tax,totalInclTax:row.total_incl_tax});
  const prepayments=invoice?await readSavedFinalInvoicePrepayments(tx,id):undefined;
  return{kind,invoiceTypeCode:row.invoice_type_code??undefined,number:row.number,draft:true,draftReference:row.number,issueDate:row.issue_date,currency:row.currency,client:row.client,lines:row.lines,
    totals:{subtotalExTax:tax.subtotal_ex_tax,globalDiscountPercent:row.discount_percent,globalDiscountAmount:tax.allowance_ex_tax,
      totalExTax:row.total_ex_tax,totalTax:row.total_tax,totalInclTax:row.total_incl_tax},taxBreakdown:tax,prepayments,
    dueDates:row.due_dates.length?row.due_dates:(row.fallback_due_date?[{dueDate:row.fallback_due_date,label:"Échéance",amount:prepayments?.amount_due??row.total_incl_tax}]:[]),
    customerText:row.customer_text,reason:row.reason,reasonCode:row.reason_code,correctedInvoice:row.corrected_invoice,
    originalGlobalDiscountPercent:row.original_global_discount_percent??undefined};
}
