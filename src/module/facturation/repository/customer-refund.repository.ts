import crypto from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { formatDecimal, moneyToCents } from "../domain/decimal-money";
import { financePreviewHash } from "../domain/finance-policy";
import { planCustomerRefund, type RefundOrigin } from "../domain/customer-refund";
import type { CustomerRefundPreviewDTO, RegisterCustomerRefundDTO } from "../validators/customer-refund.validators";
import { lockInvoiceSettlement, refreshInvoiceSettlementStates } from "./invoice-settlement.repository";
import { acquireFinanceIdempotency, insertFinanceEvent, insertFinanceOutbox, insertGlobalFinanceAudit,
  newCorrelationId, saveFinanceReceipt, type FinanceActorContext } from "./workflow.repository.shared";

type Queryer = Pick<PoolClient,"query">;
type Credit = {id:number; uuid:string; facture_id:number; client_id:string; currency:string; statut:string; amount:string; refunded:string};

/** Original allocations, direct legacy cash and advances actually used by this invoice. */
async function refundOrigins(tx: Queryer,invoiceId:number):Promise<RefundOrigin[]> {
  return (await tx.query<RefundOrigin>(`
    WITH origins AS (
      SELECT 'INVOICE_ALLOCATION'::text AS origin_type,a.id::text AS origin_id,p.id AS payment_id,a.id AS payment_allocation_id,
        greatest(0,a.amount_ttc-COALESCE((SELECT sum(r.amount_ttc) FROM public.customer_refund_sources_effective_1268 r WHERE r.origin_type='INVOICE_ALLOCATION' AND r.origin_id=a.id::text),0)
          -COALESCE((SELECT sum(applied.amount_ttc) FROM public.proforma_final_prepayments applied
            JOIN public.proforma_receipt_assignments receipt ON receipt.id=applied.receipt_assignment_id
            JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
            WHERE receipt.payment_allocation_id=a.id AND final.allocation_status IN('DRAFT','CONSUMED')),0)) AS source_available
      FROM public.paiement_allocations a JOIN public.paiement p ON p.id=a.paiement_id WHERE a.facture_id=$1
      UNION ALL
      SELECT 'INVOICE_DIRECT',p.id::text,p.id,NULL::uuid,greatest(0,p.montant-COALESCE((SELECT sum(amount_ttc)
        FROM public.customer_refund_sources_effective_1268 WHERE origin_type='INVOICE_DIRECT' AND origin_id=p.id::text),0))
      FROM public.paiement p WHERE p.facture_id=$1 AND NOT EXISTS(SELECT 1 FROM public.paiement_allocations WHERE paiement_id=p.id)
      UNION ALL
      SELECT 'APPLIED_ADVANCE',applied.id::text,p.id,a.id,greatest(0,applied.amount_ttc-COALESCE((SELECT sum(amount_ttc)
        FROM public.customer_refund_sources_effective_1268 WHERE origin_type='APPLIED_ADVANCE' AND origin_id=applied.id::text),0))
      FROM public.proforma_final_prepayments applied JOIN public.facture_source_allocations final ON final.id=applied.final_source_allocation_id
      JOIN public.proforma_receipt_assignments receipt ON receipt.id=applied.receipt_assignment_id
      JOIN public.paiement_allocations a ON a.id=receipt.payment_allocation_id JOIN public.paiement p ON p.id=a.paiement_id
      WHERE final.facture_id=$1 AND final.allocation_status='CONSUMED'
    ) SELECT origins.origin_type,origins.origin_id,p.id::int AS payment_id,origins.payment_allocation_id::text,
      COALESCE(p.code,'PAY-'||p.id::text) AS payment_number,COALESCE(p.value_date,p.date_paiement)::text AS value_date,p.mode,
      origins.source_available::numeric(18,2)::text,
      greatest(0,p.montant-COALESCE((SELECT sum(amount_ttc) FROM public.customer_refund_sources_effective_1268 WHERE paiement_id=p.id),0))::numeric(18,2)::text AS payment_available,
      CASE WHEN a.id IS NULL THEN NULL ELSE greatest(0,a.amount_ttc-COALESCE((SELECT sum(amount_ttc)
        FROM public.customer_refund_sources_effective_1268 WHERE payment_allocation_id=a.id),0))::numeric(18,2)::text END AS allocation_available
    FROM origins JOIN public.paiement p ON p.id=origins.payment_id LEFT JOIN public.paiement_allocations a ON a.id=origins.payment_allocation_id
    JOIN public.facture invoice ON invoice.id=$1
    WHERE origins.source_available>0 AND p.client_id=invoice.client_id AND p.currency=invoice.currency
      AND p.status NOT IN('REJECTED','REVERSED') AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
    ORDER BY COALESCE(p.value_date,p.date_paiement),p.id,origins.origin_type,origins.origin_id`,[invoiceId])).rows;
}

async function buildRefundPreview(tx: Queryer,input: CustomerRefundPreviewDTO) {
  const credit=(await tx.query<Credit>(`SELECT a.id::int,a.uuid::text,a.facture_id::int,a.client_id,upper(a.currency) AS currency,a.statut,
    a.total_ttc::numeric(18,2)::text AS amount,COALESCE((SELECT sum(amount_ttc) FROM public.customer_refunds_effective_1268 WHERE avoir_id=a.id),0)::numeric(18,2)::text AS refunded
    FROM public.avoir a WHERE a.id=$1`,[input.avoir_id])).rows[0];
  if (!credit) throw new HttpError(404,"AVOIR_NOT_FOUND","Avoir introuvable.");
  if (!["ISSUED","emis","emise","envoyee"].includes(credit.statut)) throw new HttpError(409,"CUSTOMER_REFUND_CREDIT_NOT_ISSUED","Émettez l’avoir avant d’enregistrer son remboursement.");
  if (!credit.uuid) throw new HttpError(409,"CUSTOMER_REFUND_CREDIT_UNQUALIFIED","Cet ancien avoir doit être rapproché avant remboursement.");
  const invoice=await lockInvoiceSettlement(tx,credit.facture_id);
  if (!invoice || invoice.clientId!==credit.client_id || invoice.currency!==credit.currency) throw new HttpError(409,"CUSTOMER_REFUND_PARTY_MISMATCH","L’avoir et la facture doivent concerner la même société et la même devise.");
  const creditRemaining=moneyToCents(credit.amount)-moneyToCents(credit.refunded),maximum=creditRemaining<invoice.refundableCents?creditRemaining:invoice.refundableCents;
  const amount=input.amount??formatDecimal(maximum,2),origins=await refundOrigins(tx,credit.facture_id);
  const plan=maximum===0n && input.amount===undefined ? {amount:"0.00",sources:[]} : planCustomerRefund({amount,invoiceRefundable:invoice.refundableCents,creditRemaining,origins});
  const unsigned={avoir_id:credit.id,facture_id:credit.facture_id,client_id:credit.client_id,currency:credit.currency,
    maximum_amount:formatDecimal(maximum,2),can_refund:maximum>0n,...plan};
  return {...unsigned,preview_hash:financePreviewHash(unsigned)};
}

export async function repoPreviewCustomerRefund(input: CustomerRefundPreviewDTO) {
  const tx=await pool.connect();try {await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const preview=await buildRefundPreview(tx,input);await tx.query('COMMIT');return preview;
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}

/** Records an already executed bank refund. It never initiates a bank transfer. */
export async function repoRegisterCustomerRefund(args:{input:RegisterCustomerRefundDTO;actor:FinanceActorContext;idempotencyKey:string|undefined}) {
  const tx=await pool.connect();try {
    await tx.query('BEGIN');
    const receipt=await acquireFinanceIdempotency({client:tx,actor:args.actor,idempotencyKeyRaw:args.idempotencyKey,
      commandType:'CUSTOMER_REFUND_REGISTER',requestPayload:args.input});
    if(receipt.replay){await tx.query('COMMIT');return {...receipt.replay,idempotent_replay:true};}
    const preview=await buildRefundPreview(tx,args.input);
    if(preview.preview_hash!==args.input.preview_hash)throw new HttpError(409,'CUSTOMER_REFUND_PREVIEW_CHANGED','Le solde ou les paiements ont changé. Actualisez le remboursement.');
    const id=crypto.randomUUID(),correlationId=newCorrelationId();
    const code=(await tx.query<{code:string}>("SELECT 'RMB-'||to_char(CURRENT_DATE,'YYYY')||'-'||lpad(nextval('public.customer_refund_number_seq')::text,6,'0') AS code")).rows[0].code;
    await tx.query(`INSERT INTO public.customer_refunds(id,code,facture_id,avoir_id,client_id,currency,amount_ttc,value_date,booking_date,
      mode,reference,reason,proof_document_id,created_by,correlation_id,source_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
      [id,code,preview.facture_id,preview.avoir_id,preview.client_id,preview.currency,preview.amount,args.input.value_date,args.input.booking_date,
        args.input.mode,args.input.reference,args.input.reason,args.input.proof_document_id??null,args.actor.userId,correlationId,JSON.stringify(preview)]);
    for(const source of preview.sources) await tx.query(`INSERT INTO public.customer_refund_sources(refund_id,origin_type,origin_id,paiement_id,payment_allocation_id,amount_ttc)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,source.origin_type,source.origin_id,source.payment_id,source.payment_allocation_id,source.amount]);
    await refreshInvoiceSettlementStates({client:tx,factureIds:[preview.facture_id],actor:args.actor,correlationId,idempotencyKey:receipt.idempotencyKey});
    const result={id,code,amount:preview.amount,avoir_id:preview.avoir_id,facture_id:preview.facture_id,currency:preview.currency,correlation_id:correlationId,idempotent_replay:false};
    const creditUuid=(await tx.query<{uuid:string}>('SELECT uuid::text FROM public.avoir WHERE id=$1',[preview.avoir_id])).rows[0].uuid;
    await insertFinanceEvent({client:tx,aggregateType:'AVOIR',aggregateId:creditUuid,
      eventType:'CUSTOMER_REFUND_RECORDED',actor:args.actor,correlationId,idempotencyKey:receipt.idempotencyKey,
      oldValues:{refund_recorded:false},newValues:{...result,sources:preview.sources},reason:args.input.reason});
    await insertGlobalFinanceAudit({client:tx,actor:args.actor,action:'facturation.customer_refund_recorded',entityType:'avoir',entityId:creditUuid,details:result});
    await insertFinanceOutbox({client:tx,eventKey:`customer-refund:${id}:recorded`,eventType:'CUSTOMER_REFUND_RECORDED',aggregateType:'AVOIR',aggregateId:creditUuid,payload:result,correlationId});
    await saveFinanceReceipt({client:tx,actor:args.actor,idempotencyKey:receipt.idempotencyKey,requestHash:receipt.requestHash,
      commandType:'CUSTOMER_REFUND_REGISTER',aggregateType:'AVOIR',aggregateId:creditUuid,requestPayload:args.input,resultPayload:result,correlationId});
    await tx.query('COMMIT');return result;
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
