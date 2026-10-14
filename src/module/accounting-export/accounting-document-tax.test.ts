import { describe,expect,it } from "vitest";
import { accountingDocumentTax } from "./accounting-document-tax";
import { buildAccountingPreview,type AccountingMappingConfig,type AccountingSourceDocument } from "./accounting-export.domain";
const source:AccountingSourceDocument={source_type:"INVOICE",source_id:"42",source_number:"FA42",source_updated_at:"2026-10-14T00:00:00.000Z",
 entry_date:"2026-10-14",client_id:"client-a",third_party_account:"411A",currency:"EUR",payment_mode:null,
 total_ex_tax:"190.00",total_tax:"24.23",total_incl_tax:"214.23",claimed_batch_id:null,
 tax_breakdown:[{tax_rate:"20.0000",total_ex_tax:"100.00",tax_amount:"20.00"},{tax_rate:"5.5000",total_ex_tax:"100.00",tax_amount:"5.50"}]};
const mapping:AccountingMappingConfig={delimiter:";",sales_journal:"VE",credit_journal:"AV",bank_journal_by_mode:{},bank_account_by_mode:{},
 default_bank_journal:null,default_bank_account:null,sales_account_by_tax:{"20":"70120","5.5":"70155"},
 vat_output_account_by_tax:{"20":"4457120","5.5":"4457155"},default_axes:{}};
describe("accounting VAT after document allowances",()=>{
 it("books the same discounted bases and tax as the frozen fiscal totals",()=>{
  const original=structuredClone(source),normalized=accountingDocumentTax(source),preview=buildAccountingPreview([normalized],mapping);
  expect(normalized.tax_breakdown).toEqual([{tax_rate:"5.5000",total_ex_tax:"95.00",tax_amount:"5.23"},{tax_rate:"20.0000",total_ex_tax:"95.00",tax_amount:"19.00"}]);
  expect(preview.findings).toEqual([]);expect(preview.currency_totals).toEqual([{currency:"EUR",debit:"214.23",credit:"214.23",balanced:true}]);
  expect(source).toEqual(original);
 });
 it("surfaces invalid fiscal snapshots as blockers without substituting a made-up model",()=>{
  const normalized=accountingDocumentTax({...source,tax_snapshot_present:true,tax_snapshot:null});
  expect(normalized.tax_breakdown).toEqual(source.tax_breakdown);
  expect(buildAccountingPreview([normalized],mapping).findings).toContainEqual(expect.objectContaining({code:"ACCOUNTING_TAX_BREAKDOWN_INVALID",severity:"BLOCKER"}));
 });
 it("leaves payments and externally approved supplier VAT untouched",()=>{
  const payment={...source,source_type:"PAYMENT" as const},supplier={...source,source_type:"SUPPLIER_INVOICE" as const};
  expect(accountingDocumentTax(payment)).toBe(payment);expect(accountingDocumentTax(supplier)).toBe(supplier);
 });
});
