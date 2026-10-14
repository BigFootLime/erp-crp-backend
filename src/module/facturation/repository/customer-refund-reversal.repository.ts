import crypto from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { financePreviewHash } from "../domain/finance-policy";
import { assertCustomerRefundReversible,customerRefundReversalError } from "../domain/customer-refund-reversal";
import type { CustomerRefundReversalPreviewDTO,ReverseCustomerRefundDTO } from "../validators/customer-refund.validators";
import { lockInvoiceSettlement,refreshInvoiceSettlementStates } from "./invoice-settlement.repository";
import { acquireFinanceIdempotency,insertFinanceEvent,insertFinanceOutbox,insertGlobalFinanceAudit,
  newCorrelationId,saveFinanceReceipt,type FinanceActorContext } from "./workflow.repository.shared";

type Queryer=Pick<PoolClient,"query">;
async function reversalPreview(tx:Queryer,input:CustomerRefundReversalPreviewDTO){
  const original=(await tx.query<{refund_id:string;refund_code:string;facture_id:number;avoir_id:number;avoir_uuid:string|null;
    client_id:string;currency:string;amount:string;mode:string;original_value_date:string;reversal_id:string|null}>(`
    SELECT refund.id::text AS refund_id,refund.code AS refund_code,refund.facture_id::int,refund.avoir_id::int,
      credit.uuid::text AS avoir_uuid,refund.client_id,refund.currency,refund.amount_ttc::numeric(18,2)::text AS amount,
      refund.mode,refund.value_date::text AS original_value_date,reversal.id::text AS reversal_id
    FROM public.customer_refunds refund JOIN public.avoir credit ON credit.id=refund.avoir_id
    LEFT JOIN public.customer_refund_reversals reversal ON reversal.refund_id=refund.id
    WHERE refund.id=$1::uuid`,[input.refund_id])).rows[0];
  if(!original)throw new HttpError(404,"CUSTOMER_REFUND_NOT_FOUND","Remboursement introuvable.");
  const unsigned={...original,can_reverse:!original.reversal_id&&Boolean(original.avoir_uuid)};
  return{...unsigned,preview_hash:financePreviewHash(unsigned)};
}

export async function repoPreviewCustomerRefundReversal(input:CustomerRefundReversalPreviewDTO){
  return reversalPreview(pool,input);
}

/** Records correction of an erroneous bank fact; never initiates a transfer. */
export async function repoReverseCustomerRefund(args:{input:ReverseCustomerRefundDTO;actor:FinanceActorContext;idempotencyKey:string|undefined}){
  const tx=await pool.connect();
  try{
    await tx.query('BEGIN');
    const receipt=await acquireFinanceIdempotency({client:tx,actor:args.actor,idempotencyKeyRaw:args.idempotencyKey,
      commandType:'CUSTOMER_REFUND_REVERSE',requestPayload:args.input});
    if(receipt.replay){await tx.query('COMMIT');return{...receipt.replay,idempotent_replay:true};}
    await tx.query('SELECT public.fn_lock_delivery_prepayment_write_1268()');
    const preview=await reversalPreview(tx,args.input);
    assertCustomerRefundReversible({amount:preview.amount,valueDate:preview.original_value_date,reversalId:preview.reversal_id},args.input.value_date);
    if(!preview.avoir_uuid)throw new HttpError(409,"CUSTOMER_REFUND_REQUIRES_RECONCILIATION","L'avoir d'origine doit être rapproché avant correction.");
    if(preview.preview_hash!==args.input.preview_hash)throw new HttpError(409,"CUSTOMER_REFUND_REVERSAL_PREVIEW_CHANGED","Le remboursement a changé. Actualisez sa correction.");
    const invoice=await lockInvoiceSettlement(tx,preview.facture_id);
    if(!invoice||invoice.clientId!==preview.client_id||invoice.currency!==preview.currency)
      throw new HttpError(409,"CUSTOMER_REFUND_PARTY_MISMATCH","Le remboursement et la facture doivent concerner la même société et la même devise.");
    const id=crypto.randomUUID(),correlationId=newCorrelationId();
    const code=(await tx.query<{code:string}>(`SELECT 'RMB-COR-'||to_char(CURRENT_DATE,'YYYY')||'-'||lpad(nextval('public.customer_refund_reversal_number_seq')::text,6,'0') AS code`)).rows[0].code;
    await tx.query(`INSERT INTO public.customer_refund_reversals(id,code,refund_id,facture_id,avoir_id,client_id,currency,amount_ttc,
      value_date,booking_date,mode,reference,reason,proof_document_id,source_snapshot,created_by,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
      [id,code,preview.refund_id,preview.facture_id,preview.avoir_id,preview.client_id,preview.currency,preview.amount,
       args.input.value_date,args.input.booking_date,preview.mode,args.input.reference,args.input.reason,args.input.proof_document_id??null,
       JSON.stringify(preview),args.actor.userId,correlationId]);
    await refreshInvoiceSettlementStates({client:tx,factureIds:[preview.facture_id],actor:args.actor,correlationId,idempotencyKey:receipt.idempotencyKey});
    const result={id,code,refund_id:preview.refund_id,avoir_id:preview.avoir_id,facture_id:preview.facture_id,
      amount:preview.amount,currency:preview.currency,correlation_id:correlationId,idempotent_replay:false};
    await insertFinanceEvent({client:tx,aggregateType:'AVOIR',aggregateId:preview.avoir_uuid,eventType:'CUSTOMER_REFUND_REVERSED',
      actor:args.actor,correlationId,idempotencyKey:receipt.idempotencyKey,oldValues:{refund_id:preview.refund_id,correction:null},newValues:result,reason:args.input.reason});
    await insertGlobalFinanceAudit({client:tx,actor:args.actor,action:'facturation.customer_refund_reversed',entityType:'avoir',entityId:preview.avoir_uuid,details:result});
    await insertFinanceOutbox({client:tx,eventKey:`customer-refund:${preview.refund_id}:reversed`,eventType:'CUSTOMER_REFUND_REVERSED',
      aggregateType:'AVOIR',aggregateId:preview.avoir_uuid,payload:result,correlationId});
    await saveFinanceReceipt({client:tx,actor:args.actor,idempotencyKey:receipt.idempotencyKey,requestHash:receipt.requestHash,
      commandType:'CUSTOMER_REFUND_REVERSE',aggregateType:'AVOIR',aggregateId:preview.avoir_uuid,requestPayload:args.input,resultPayload:result,correlationId});
    await tx.query('COMMIT');return result;
  }catch(error){await tx.query('ROLLBACK').catch(()=>undefined);throw customerRefundReversalError(error);}finally{tx.release();}
}
