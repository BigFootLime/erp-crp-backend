import type { PoolClient } from "pg";
import { describe,expect,it,vi } from "vitest";
import { readFinanceDraftInput } from "./finance-draft-input";
const row={number:"DRAFT-42",issue_date:"2026-10-14",document_status:"DRAFT",legacy_status:"DRAFT",currency:"USD",invoice_type_code:380,
 client:{company_name:"Fictional client"},immutable_snapshot:null,total_ex_tax:"75.00",total_tax:"15.00",total_incl_tax:"90.00",discount_percent:"0.0000",
 lines:[{designation:"Barre fictive",codePiece:"MP-Q",quantity:"3000.000",unit:"mm",unitPriceExTax:"0.0250",discountPercent:"0.0000",taxRatePercent:"20.0000",totalExTax:"75.00",taxAmount:"15.00",totalInclTax:"90.00"}],
 due_dates:[{dueDate:"2026-11-14",label:"Solde",amount:"90.00"}],fallback_due_date:"2026-11-14",customer_text:"Texte public",reason:null,reason_code:null,corrected_invoice:null};
const queryer=(data:unknown)=>({query:vi.fn(async(sql:string)=>({rows:sql.includes('AS paid,amount_due_at_issue')?[{paid:"0.00",due:null}]:[data]}))} as unknown as Pick<PoolClient,"query">);
describe("exact financial draft readers",()=>{
 it("keeps unit price precision, currency and the recorded installments",async()=>{
  const input=await readFinanceDraftInput(queryer(row),"FACTURE",42);
  expect(input.lines[0].unitPriceExTax).toBe("0.0250");expect(input.lines[0].quantity).toBe("3000.000");
  expect(input.currency).toBe("USD");expect(input.customerText).toBe("Texte public");expect(input.dueDates).toEqual(row.due_dates);
 });
 it("refuses both canonical and historical issued states before regeneration",async()=>{
  await expect(readFinanceDraftInput(queryer({...row,document_status:"ISSUED"}),"FACTURE",42)).rejects.toMatchObject({code:"FACTURE_DOCUMENT_IMMUTABLE"});
  await expect(readFinanceDraftInput(queryer({...row,document_status:null,legacy_status:"emise"}),"FACTURE",42)).rejects.toMatchObject({code:"FACTURE_DOCUMENT_IMMUTABLE"});
 });
 it("keeps credit-note identity and emits no payment due dates",async()=>{
  const input=await readFinanceDraftInput(queryer({...row,document_status:null,due_dates:[],fallback_due_date:null,invoice_type_code:null,
    customer_text:null,reason:"Retour de test",reason_code:"NON_CONFORME",corrected_invoice:"F-1"}),"AVOIR",42);
  expect(input.correctedInvoice).toBe("F-1");expect(input.reason).toBe("Retour de test");expect(input.dueDates).toEqual([]);
 });
 it("rejects invalid identifiers instead of querying another document context",async()=>{
  const tx=queryer(row);await expect(readFinanceDraftInput(tx,"FACTURE",NaN)).rejects.toMatchObject({code:"FINANCE_DOCUMENT_CONTEXT_INVALID"});
  expect(tx.query).not.toHaveBeenCalled();
 });
});
