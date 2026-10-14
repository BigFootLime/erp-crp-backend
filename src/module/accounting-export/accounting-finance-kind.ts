import type { AccountingSourceDocument } from "./accounting-export.domain";
import { invoiceTypeCodeFromSnapshot } from "../facturation/domain/invoice-kind";
import { invoicePrepaymentAmountsFromSnapshot } from "../facturation/domain/final-invoice-prepayments";
import { readAdvanceClearing } from "../facturation/domain/advance-clearing";

/** The issued fiscal record decides the posting family; labels and current
 * payment balances never turn an advance into a sale. */
export function accountingFinanceKind(source:AccountingSourceDocument):AccountingSourceDocument{
  if(source.source_type!=="INVOICE"&&source.source_type!=="CREDIT_NOTE")return source;
  try{
    const snapshot=source.source_type==="CREDIT_NOTE"?source.corrected_invoice_fiscal_snapshot:source.fiscal_snapshot;
    const kind=invoiceTypeCodeFromSnapshot(snapshot);
    if(source.has_deposit_sources&&kind!==386)return{...source,financial_context_error:{code:"ACCOUNTING_ADVANCE_KIND_UNQUALIFIED",
      message:"Le type fiscal de cet acompte doit être vérifié ; il ne peut pas être exporté comme une vente."}};
    if(kind===386 && source.has_unqualified_advance_cash) return { ...source, financial_context_error: {
      code: "ACCOUNTING_ADVANCE_CASH_UNQUALIFIED", message: "Les anciens encaissements d'acompte doivent être rapprochés avant export de la TVA." } };
    if(kind===386)return{...source,financial_kind:source.source_type==="CREDIT_NOTE"?"ADVANCE_CREDIT":"ADVANCE"};
    const paid=source.source_type==="INVOICE"?invoicePrepaymentAmountsFromSnapshot(snapshot,source.total_incl_tax):undefined;
    if (paid && paid.amountPaid !== "0.00") return { ...source, financial_kind: "FINAL_WITH_ADVANCES",
      advance_clearing: snapshot?.advance_clearing === undefined ? undefined : readAdvanceClearing(snapshot.advance_clearing,paid.amountPaid) };
    return { ...source, financial_kind: "STANDARD" };
  }catch(error){return{...source,financial_context_error:{code:"ACCOUNTING_FISCAL_CONTEXT_INVALID",
    message:"Les faits fiscaux figés de la pièce doivent être vérifiés avant export."}};}
}
