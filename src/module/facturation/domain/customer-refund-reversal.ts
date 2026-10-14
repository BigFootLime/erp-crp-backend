import { HttpError } from "../../../utils/httpError";
import { moneyToCents } from "./decimal-money";

export function assertCustomerRefundReversible(refund:{amount:string;valueDate:string;reversalId:string|null},reversalDate?:string):void {
  if(refund.reversalId)throw new HttpError(409,"CUSTOMER_REFUND_ALREADY_REVERSED","Ce remboursement possède déjà sa correction.");
  if(moneyToCents(refund.amount)<=0n)throw new HttpError(409,"CUSTOMER_REFUND_REQUIRES_RECONCILIATION","Le remboursement d'origine doit être rapproché avant correction.");
  if(reversalDate && reversalDate<refund.valueDate)throw new HttpError(422,"CUSTOMER_REFUND_REVERSAL_DATE_INVALID","La correction ne peut pas précéder le remboursement d'origine.");
}

export function customerRefundReversalError(error:unknown):unknown {
  const failure=error as {code?:string;message?:string;constraint?:string}|null;
  if(failure?.code==='23505' && failure.constraint==='customer_refund_reversals_refund_id_key')
    return new HttpError(409,'CUSTOMER_REFUND_ALREADY_REVERSED','Ce remboursement possède déjà sa correction.');
  if(failure?.code==='23514' && failure.message?.startsWith('REFUND-REVERSAL-1268'))
    return new HttpError(409,'CUSTOMER_REFUND_REVERSAL_CONFLICT','Le remboursement ou son export a changé. Actualisez sa correction.');
  return error;
}
