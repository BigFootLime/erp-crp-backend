import { HttpError } from "../../utils/httpError";
import { documentTaxBreakdownFromSnapshot } from "../facturation/domain/document-tax-breakdown";
import type { AccountingSourceDocument } from "./accounting-export.domain";

/** An export reads fiscal evidence; it cannot silently book undiscounted bases. */
export function accountingDocumentTax(source:AccountingSourceDocument):AccountingSourceDocument{
  if(source.source_type!=="INVOICE" && source.source_type!=="CREDIT_NOTE")return source;
  try{
    const model=documentTaxBreakdownFromSnapshot({
      snapshot:source.tax_snapshot_present?{tax_breakdown:source.tax_snapshot}:{},
      lines:source.tax_breakdown.map(group=>({ratePercent:group.tax_rate,net:group.total_ex_tax,tax:group.tax_amount})),
      totalExTax:source.total_ex_tax,totalTax:source.total_tax,totalInclTax:source.total_incl_tax});
    return{...source,tax_breakdown:model.entries.map(group=>({tax_rate:group.rate_percent,total_ex_tax:group.taxable_amount,tax_amount:group.tax_amount}))};
  }catch(error){
    if(!(error instanceof HttpError)||error.status>=500)throw error;
    return{...source,tax_breakdown_error:{code:error.code,message:error.message}};
  }
}
