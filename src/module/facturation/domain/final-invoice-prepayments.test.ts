import { describe,expect,it } from "vitest";
import { invoicePrepaymentAmountsFromSnapshot,planFinalInvoicePrepayments,type FinalPrepaymentReceipt,type FinalPrepaymentTarget } from "./final-invoice-prepayments";
const receipt=(overrides:Partial<FinalPrepaymentReceipt>={}):FinalPrepaymentReceipt=>({assignment_id:"cash-1",deposit_source_id:"advance-1",billing_part_id:"part-a",
  billed_client_id:"company-a",currency:"EUR",deposit_invoice_id:10,deposit_invoice_number:"F-ADV-10",deposit_invoice_date:"2026-10-01",
  available_amount:"120.00",deposit_total_ex_tax:"100.00",deposit_total_tax:"20.00",deposit_total_incl_tax:"120.00",
  deposit_available_incl_tax:"120.00",deposit_already_applied_incl_tax:"0.00",deposit_already_applied_ex_tax:"0.00",...overrides});
const target=(overrides:Partial<FinalPrepaymentTarget>={}):FinalPrepaymentTarget=>({source_line_id:"bl-line-1",billing_part_id:"part-a",amount_incl_tax:"240.00",...overrides});
const plan=(receipts:FinalPrepaymentReceipt[],targets=[target()],total="240.00")=>planFinalInvoicePrepayments({billedClientId:"company-a",currency:"EUR",invoiceTotalInclTax:total,targets,receipts});
describe("#1268 final invoice advance application",()=>{
 it("rejects contradictory cash budgets, company parts and targets before issuing",()=>{
  expect(()=>plan([receipt(),receipt({assignment_id:"cash-2"})])).toThrow();
  expect(()=>plan([receipt({available_amount:"60.00"}),receipt({assignment_id:"cash-2",available_amount:"60.00",billing_part_id:"part-b"})])).toThrow();
  expect(()=>plan([receipt()], [target({amount_incl_tax:"240.01"})])).toThrow();
  expect(()=>plan([receipt({deposit_invoice_number:""})])).toThrow();
 });
 it("reads issuance facts without retrofitting legacy invoices or accepting inconsistent due",()=>{
  expect(invoicePrepaymentAmountsFromSnapshot({prepayments:{version:1,amount_paid:"80.00",amount_due:"40.00"}},"120.00")).toEqual({amountPaid:"80.00",amountDue:"40.00"});
  expect(invoicePrepaymentAmountsFromSnapshot({},"120.00")).toBeUndefined();
  expect(()=>invoicePrepaymentAmountsFromSnapshot({prepayments:{version:1,amount_paid:"80.00",amount_due:"40.01"}},"120.00")).toThrow();
  expect(()=>invoicePrepaymentAmountsFromSnapshot({prepayments:null},"120.00")).toThrow();
 });
 it("deducts only real available cash without changing gross VAT or recording cash",()=>{
  const inputs=[receipt()],before=structuredClone(inputs),result=plan(inputs);
  expect(result).toMatchObject({amount_paid:"120.00",amount_due:"120.00",applications:[{amount_ex_tax:"100.00",tax_amount:"20.00",amount_incl_tax:"120.00",deposit_invoice_number:"F-ADV-10"}]});
  expect(inputs).toEqual(before);
 });
 it("uses a partial receipt rather than the nominal amount of its invoice",()=>{
  expect(plan([receipt({available_amount:"80.00"})])).toMatchObject({amount_paid:"80.00",amount_due:"160.00",applications:[{amount_ex_tax:"66.67",tax_amount:"13.33"}]});
 });
 it("keeps a fully prepaid invoice at zero due without a fabricated payment or cent",()=>{
  expect(plan([receipt()], [target({amount_incl_tax:"120.00"})],"120.00").amount_due).toBe("0.00");
 });
 it("does not apply a billed company's money to another affair or duplicate it across BLs",()=>{
  const targets=[target({amount_incl_tax:"60.00"}),target({source_line_id:"bl-line-2",amount_incl_tax:"120.00"}),target({source_line_id:"bl-line-3",billing_part_id:"part-b",amount_incl_tax:"60.00"})];
  expect(plan([receipt()],targets).applications.map(a=>[a.source_line_id,a.amount_incl_tax])).toEqual([["bl-line-1","60.00"],["bl-line-2","60.00"]]);
 });
 it("does not reuse amounts reserved or applied by earlier invoices",()=>{
  expect(plan([receipt({available_amount:"60.00",deposit_available_incl_tax:"60.00",deposit_already_applied_incl_tax:"60.00",deposit_already_applied_ex_tax:"50.00"})])).toMatchObject({amount_paid:"60.00",amount_due:"180.00"});
 });
 it("caps credited source availability independently from the remaining receipt",()=>{
  expect(plan([receipt({deposit_available_incl_tax:"80.00"})]).amount_paid).toBe("80.00");
 });
 it("preserves all cents across small successive net/VAT allocations",()=>{
  const one=receipt({available_amount:"0.03",deposit_total_ex_tax:"0.02",deposit_total_tax:"0.01",deposit_total_incl_tax:"0.03",deposit_available_incl_tax:"0.03"});
  const result=plan([one],[target({amount_incl_tax:"0.01"}),target({source_line_id:"bl-line-2",amount_incl_tax:"0.01"}),target({source_line_id:"bl-line-3",amount_incl_tax:"0.01"})],"0.03");
  expect(result.applications.map(a=>[a.amount_ex_tax,a.tax_amount])).toEqual([["0.01","0.00"],["0.00","0.01"],["0.01","0.00"]]);
 });
 it.each([{billed_client_id:"company-b"},{currency:"USD"},{available_amount:"-0.01"},{deposit_total_tax:"19.99"}])("refuses corrupt or foreign cash evidence %j",changed=>{
  expect(()=>plan([receipt(changed)])).toThrow(expect.objectContaining({code:"PROFORMA_PREPAYMENT_EVIDENCE_INVALID"}));
 });
 it("refuses duplicate receipt identities or physical targets rather than doubling coverage",()=>{
  expect(()=>plan([receipt(),receipt()])).toThrow(expect.objectContaining({code:"PROFORMA_PREPAYMENT_EVIDENCE_INVALID"}));
  expect(()=>plan([receipt()],[target(),target()])).toThrow(expect.objectContaining({code:"PROFORMA_PREPAYMENT_EVIDENCE_INVALID"}));
 });
 it("returns full due for no available cash and keeps the final invoice budget",()=>{
  expect(plan([])).toEqual({version:1,amount_paid:"0.00",amount_due:"240.00",applications:[]});
  expect(plan([receipt()], [target({amount_incl_tax:"40.00"})],"40.00").amount_paid).toBe("40.00");
 });
});
