import { describe,expect,it } from "vitest";
import { accountingFinanceKind } from "./accounting-finance-kind";
import { buildAccountingPreview,type AccountingSourceDocument,type AccountingMappingConfig } from "./accounting-export.domain";
const base:AccountingSourceDocument={source_type:"INVOICE",source_id:"1",source_number:"FIXTURE-AC-1",source_updated_at:"2026-10-14T08:00:00Z",entry_date:"2026-10-14",client_id:"fixture",
 third_party_account:"411FIXTURE",currency:"EUR",payment_mode:null,total_ex_tax:"100.00",total_tax:"20.00",total_incl_tax:"120.00",
 tax_breakdown:[{tax_rate:"20",total_ex_tax:"100.00",tax_amount:"20.00"}],claimed_batch_id:null,fiscal_snapshot:{invoice_type_code:"386"}};
const mapping:AccountingMappingConfig={delimiter:";",sales_journal:"VE",credit_journal:"AV",bank_journal_by_mode:{},bank_account_by_mode:{},default_bank_journal:null,default_bank_account:null,
 sales_account_by_tax:{"20":"701000"},vat_output_account_by_tax:{"20":"445710"},advance_account_by_tax:{"20":"419100"},advance_vat_pending_account_by_tax:{"20":"445800"},default_axes:{}};
describe("advance accounting classification",()=>{
 it("uses the issued type386 and configured liability/pending VAT accounts, with no sales entry",()=>{
  const source=accountingFinanceKind({...base,has_deposit_sources:true}),result=buildAccountingPreview([source],mapping);
  expect(source.financial_kind).toBe("ADVANCE");expect(result.findings).toEqual([]);
  expect(result.lines.map(line=>[line.account_number,line.debit,line.credit])).toEqual([["411FIXTURE","120.00","0.00"],["419100","0.00","100.00"],["445800","0.00","20.00"]]);
  expect(result.currency_totals).toEqual([{currency:"EUR",debit:"120.00",credit:"120.00",balanced:true}]);
 });
 it("blocks missing advance accounts instead of substituting sales or collected VAT",()=>{
  const result=buildAccountingPreview([accountingFinanceKind(base)],{...mapping,advance_account_by_tax:undefined,advance_vat_pending_account_by_tax:undefined});
  expect(result.findings.map(f=>f.code)).toContain("ACCOUNTING_ADVANCE_ACCOUNT_MISSING");
  expect(result.findings.map(f=>f.code)).toContain("ACCOUNTING_ADVANCE_PENDING_VAT_ACCOUNT_MISSING");
  expect(result.lines.some(line=>["701000","445710"].includes(line.account_number))).toBe(false);
 });
 it("does not export a legacy monetary deposit as a sale without qualified fiscal metadata",()=>{
  const result=buildAccountingPreview([accountingFinanceKind({...base,fiscal_snapshot:{},has_deposit_sources:true})],mapping);
  expect(result.findings.map(f=>f.code)).toContain("ACCOUNTING_ADVANCE_KIND_UNQUALIFIED");expect(result.lines).toEqual([]);
 });
 it("keeps legacy standard invoices compatible and identifies final deductions separately",()=>{
  expect(accountingFinanceKind({...base,fiscal_snapshot:null,has_deposit_sources:false}).financial_kind).toBe("STANDARD");
  expect(accountingFinanceKind({...base,fiscal_snapshot:{invoice_type_code:380,prepayments:{version:1,amount_paid:"80.00",amount_due:"40.00"}}}).financial_kind).toBe("FINAL_WITH_ADVANCES");
 });
 it("never mistakes an advance credit or unqualified final settlement for a standard sale",()=>{
  const credit=accountingFinanceKind({...base,source_type:"CREDIT_NOTE",corrected_invoice_fiscal_snapshot:{invoice_type_code:386}});
  expect(credit.financial_kind).toBe("ADVANCE_CREDIT");
  expect(buildAccountingPreview([credit],mapping).findings.map(f=>f.code)).toContain("ACCOUNTING_ADVANCE_SETTLEMENT_CONTEXT_REQUIRED");
 });
 it("rejects unknown fiscal types and contradictory retained prepayments",()=>{
  expect(accountingFinanceKind({...base,fiscal_snapshot:{invoice_type_code:999}}).financial_context_error?.code).toBe("ACCOUNTING_FISCAL_CONTEXT_INVALID");
  expect(accountingFinanceKind({...base,fiscal_snapshot:{prepayments:{version:1,amount_paid:"80.00",amount_due:"39.00"}}}).financial_context_error?.code).toBe("ACCOUNTING_FISCAL_CONTEXT_INVALID");
 });
 it("does not hide missing VAT effects on historical advance cash",()=>{
  const source=accountingFinanceKind({...base,has_unqualified_advance_cash:true});
  expect(buildAccountingPreview([source],mapping).lines).toEqual([]);
  expect(source.financial_context_error?.code).toBe("ACCOUNTING_ADVANCE_CASH_UNQUALIFIED");
 });
});
