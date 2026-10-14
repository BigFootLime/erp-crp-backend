import type { PoolClient } from "pg";
import type { FinalPrepaymentPlan,FinalPrepaymentReceipt,FinalPrepaymentApplication } from "../domain/final-invoice-prepayments";

type Queryer=Pick<PoolClient,"query">;

/** Saved draft evidence also feeds its printable preview; old drafts stay compatible. */
export async function readSavedFinalInvoicePrepayments(tx:Queryer,invoiceId:number):Promise<FinalPrepaymentPlan|undefined>{
 const header=(await tx.query<{paid:string;due:string|null}>(`SELECT prepaid_amount_ttc::text AS paid,amount_due_at_issue::text AS due
   FROM public.facture WHERE id=$1`,[invoiceId])).rows[0];
 if(!header || header.due===null)return undefined;
 const applications=(await tx.query<FinalPrepaymentApplication>(`SELECT final.source_line_id,applied.proforma_billing_part_id::text AS billing_part_id,
   applied.receipt_assignment_id::text AS assignment_id,applied.deposit_source_id::text,
   advance.id::int AS deposit_invoice_id,COALESCE(advance.legal_number,advance.numero) AS deposit_invoice_number,
   advance.date_emission::text AS deposit_invoice_date,applied.amount_ex_tax::text,applied.tax_amount::text,applied.amount_ttc::text AS amount_incl_tax
   FROM public.proforma_final_prepayments applied JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
   JOIN public.facture_source_allocations deposit ON deposit.id=applied.deposit_source_id JOIN public.facture advance ON advance.id=deposit.facture_id
   WHERE final.facture_id=$1 AND final.allocation_status IN('DRAFT','CONSUMED') ORDER BY final.source_line_id,applied.proforma_billing_part_id,advance.date_emission,advance.id,applied.receipt_assignment_id`,[invoiceId])).rows;
 return{version:1,amount_paid:header.paid,amount_due:header.due,applications};
}

/** Real cash on issued advance lines. Credit notes cap money; they do not create it. */
export async function readFinalInvoicePrepaymentReceipts(tx:Queryer,args:{partIds:readonly string[];clientId:string;currency:string;ownInvoiceId?:number}):Promise<FinalPrepaymentReceipt[]>{
 if(!args.partIds.length)return[];
 const rows=await tx.query<FinalPrepaymentReceipt>(`
  SELECT receipt.id::text AS assignment_id,receipt.deposit_source_id::text,part.id::text AS billing_part_id,
   part.billed_client_id,invoice.currency,invoice.id::int AS deposit_invoice_id,
   COALESCE(invoice.legal_number,invoice.numero) AS deposit_invoice_number,invoice.date_emission::text AS deposit_invoice_date,
   greatest(0,receipt.amount_ttc-COALESCE(released.amount,0)-COALESCE(receipt_used.amount,0))::numeric(18,2)::text AS available_amount,
   deposit.amount_ex_tax::numeric(18,2)::text AS deposit_total_ex_tax,
   (deposit.amount_incl_tax-deposit.amount_ex_tax)::numeric(18,2)::text AS deposit_total_tax,
   deposit.amount_incl_tax::numeric(18,2)::text AS deposit_total_incl_tax,
   greatest(0,deposit.amount_incl_tax-COALESCE(credit.amount,0)-COALESCE(source_used.gross,0))::numeric(18,2)::text AS deposit_available_incl_tax,
   COALESCE(source_used.gross,0)::numeric(18,2)::text AS deposit_already_applied_incl_tax,
   COALESCE(source_used.net,0)::numeric(18,2)::text AS deposit_already_applied_ex_tax
  FROM public.proforma_receipt_assignments receipt
  JOIN public.proforma_deposit_sources binding ON binding.facture_source_allocation_id=receipt.deposit_source_id
  JOIN public.proforma_billing_parts part ON part.id=binding.proforma_billing_part_id
  JOIN public.facture_source_allocations deposit ON deposit.id=receipt.deposit_source_id
  JOIN public.facture invoice ON invoice.id=deposit.facture_id
  JOIN public.paiement_allocations payment_allocation ON payment_allocation.id=receipt.payment_allocation_id
  JOIN public.paiement payment ON payment.id=payment_allocation.paiement_id
  LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id) released ON true
  LEFT JOIN LATERAL (SELECT sum(applied.amount_ttc) AS amount FROM public.proforma_final_prepayments applied
    JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
    WHERE applied.receipt_assignment_id=receipt.id AND final.allocation_status IN ('DRAFT','CONSUMED')
      AND ($4::bigint IS NULL OR final.facture_id<>$4)) receipt_used ON true
  LEFT JOIN LATERAL (SELECT sum(applied.amount_ttc) AS gross,sum(applied.amount_ex_tax) AS net FROM public.proforma_final_prepayments applied
    JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
    WHERE applied.deposit_source_id=deposit.id AND final.allocation_status IN ('DRAFT','CONSUMED')
      AND ($4::bigint IS NULL OR final.facture_id<>$4)) source_used ON true
  LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.avoir_source_allocations
    WHERE facture_id=deposit.facture_id AND facture_ligne_id=deposit.facture_ligne_id AND allocation_status='CONSUMED') credit ON true
  WHERE part.id=ANY($1::uuid[]) AND part.billed_client_id=$2 AND invoice.client_id::text=$2 AND invoice.currency=$3
    AND payment.client_id::text=$2 AND payment.currency=$3 AND payment_allocation.facture_id=invoice.id
    AND deposit.source_type='DEPOSIT' AND deposit.allocation_status='CONSUMED' AND invoice.document_status='ISSUED'
    AND invoice.immutable_snapshot->>'invoice_type_code'='386'
    AND payment.status IN ('UNALLOCATED','PARTIALLY_ALLOCATED','ALLOCATED') AND payment.workflow_status IN ('RECORDED','ALLOCATED') AND payment.reversal_of_id IS NULL
  ORDER BY invoice.date_emission,invoice.id,receipt.id`,[[...new Set(args.partIds)].sort(),args.clientId,args.currency,args.ownInvoiceId??null]);
 return rows.rows;
}

/** Retained applications reference the original bank evidence, never another payment. */
export async function bindFinalInvoicePrepayments(tx:Queryer,args:{invoiceId:number;plan:FinalPrepaymentPlan;sourceIds:ReadonlyMap<string,string>;actorId:number;correlationId:string}):Promise<void>{
 for(const application of args.plan.applications){
  const sourceId=args.sourceIds.get(application.source_line_id);if(!sourceId)throw new Error("FINAL_PREPAYMENT_SOURCE_NOT_SAVED");
  await tx.query(`INSERT INTO public.proforma_final_prepayments(final_source_allocation_id,proforma_billing_part_id,
    receipt_assignment_id,deposit_source_id,amount_ex_tax,tax_amount,amount_ttc,created_by,correlation_id)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::numeric,$6::numeric,$7::numeric,$8,$9::uuid)`,
    [sourceId,application.billing_part_id,application.assignment_id,application.deposit_source_id,application.amount_ex_tax,application.tax_amount,application.amount_incl_tax,args.actorId,args.correlationId]);
 }
 await tx.query("UPDATE public.facture SET prepaid_amount_ttc=$2::numeric,amount_due_at_issue=$3::numeric WHERE id=$1",[args.invoiceId,args.plan.amount_paid,args.plan.amount_due]);
}
