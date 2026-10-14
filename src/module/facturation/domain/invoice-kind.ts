import { HttpError } from "../../../utils/httpError";
export type InvoiceTypeCode=380|386;
/** Missing metadata belongs to the historical standard invoice format. */
export function invoiceTypeCodeFromSnapshot(snapshot:Readonly<Record<string,unknown>>|null|undefined):InvoiceTypeCode {
  const value=snapshot?.invoice_type_code;
  if(value===undefined||value===null)return 380;
  if(value===380||value==='380')return 380;
  if(value===386||value==='386')return 386;
  throw new HttpError(422,'FINANCE_INVOICE_TYPE_UNKNOWN',"Le type de la facture émise doit être vérifié avant transmission.");
}
