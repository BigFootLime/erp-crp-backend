import { describe,expect,it } from "vitest";
import { allocateDocumentTaxBreakdown,documentTaxBreakdownFromSnapshot } from "./document-tax-breakdown";
const input={lines:[{ratePercent:"20",net:"100.00",tax:"20.00"},{ratePercent:"5.5",net:"100.00",tax:"5.50"}],
 totalExTax:"190.00",totalTax:"24.23",totalInclTax:"214.23"};
describe("document VAT and global allowances",()=>{
 it("keeps the declared totals while reducing both VAT bases",()=>{
  const original=structuredClone(input),result=allocateDocumentTaxBreakdown(input);
  expect(result).toMatchObject({allowance_ex_tax:"10.00",total_ex_tax:"190.00",total_tax:"24.23",entries:[
   {rate_percent:"5.5000",subtotal_ex_tax:"100.00",allowance_ex_tax:"5.00",taxable_amount:"95.00",tax_amount:"5.23"},
   {rate_percent:"20.0000",subtotal_ex_tax:"100.00",allowance_ex_tax:"5.00",taxable_amount:"95.00",tax_amount:"19.00"},
  ]});expect(input).toEqual(original);
 });
 it("combines equivalent VAT rate formats and preserves every cent",()=>{
  expect(allocateDocumentTaxBreakdown({lines:[{ratePercent:"20",net:"0.03",tax:"0.01"},{ratePercent:"20.0000",net:"0.03",tax:"0.01"}],
   totalExTax:"0.05",totalTax:"0.02",totalInclTax:"0.07"})).toMatchObject({entries:[{taxable_amount:"0.05",allowance_ex_tax:"0.01",tax_amount:"0.02"}]});
 });
 it("does not lose digits above the JavaScript safe integer range",()=>{
  expect(allocateDocumentTaxBreakdown({lines:[{ratePercent:"20",net:"8000000000000000.00",tax:"1600000000000000.00"}],
   totalExTax:"7600000000000000.00",totalTax:"1520000000000000.00",totalInclTax:"9120000000000000.00"})).toMatchObject({
    allowance_ex_tax:"400000000000000.00",entries:[{taxable_amount:"7600000000000000.00",tax_amount:"1520000000000000.00"}]});
 });
 it("retains old declared line-rounded VAT without repricing",()=>{
  const lines=Array.from({length:100},()=>({ratePercent:"20",net:"0.03",tax:"0.01"}));
  expect(allocateDocumentTaxBreakdown({lines,totalExTax:"3.00",totalTax:"1.00",totalInclTax:"4.00"}).total_tax).toBe("1.00");
 });
 it("handles free documents and an exact complete discount",()=>{
  expect(allocateDocumentTaxBreakdown({lines:[],totalExTax:"0.00",totalTax:"0.00",totalInclTax:"0.00"}).entries).toEqual([]);
  expect(allocateDocumentTaxBreakdown({...input,totalExTax:"0.00",totalTax:"0.00",totalInclTax:"0.00"}).allowance_ex_tax).toBe("200.00");
 });
 it("preserves the original rounded VAT of each category when no document allowance exists",()=>{
  const lines=[...Array.from({length:100},()=>({ratePercent:"20",net:"0.03",tax:"0.01"})),{ratePercent:"5.5",net:"10.00",tax:"0.55"}];
  expect(allocateDocumentTaxBreakdown({lines,totalExTax:"13.00",totalTax:"1.55",totalInclTax:"14.55"}).entries).toMatchObject([
   {rate_percent:"5.5000",taxable_amount:"10.00",tax_amount:"0.55"},{rate_percent:"20.0000",taxable_amount:"3.00",tax_amount:"1.00"},
  ]);
 });
 it.each([{totalExTax:"200.01",totalTax:"24.23",totalInclTax:"224.24"},{totalInclTax:"214.24"},
  {totalTax:"30.00",totalInclTax:"220.00"}])("rejects inconsistent financial evidence %j",changed=>{
   expect(()=>allocateDocumentTaxBreakdown({...input,...changed})).toThrow();
 });
 it("refuses fake tax on a zero rate and totals with no source",()=>{
  expect(()=>allocateDocumentTaxBreakdown({lines:[{ratePercent:"0",net:"100.00",tax:"20.00"}],totalExTax:"100.00",totalTax:"20.00",totalInclTax:"120.00"})).toThrow();
  expect(()=>allocateDocumentTaxBreakdown({...input,lines:[]})).toThrow();
 });
 it("validates frozen snapshots and derives legacy models only from saved values",()=>{
  const tax_breakdown=allocateDocumentTaxBreakdown(input);
  expect(documentTaxBreakdownFromSnapshot({...input,snapshot:{tax_breakdown}})).toEqual(tax_breakdown);
  expect(documentTaxBreakdownFromSnapshot({...input,snapshot:{legacy:true}})).toEqual(tax_breakdown);
  expect(()=>documentTaxBreakdownFromSnapshot({...input,snapshot:{tax_breakdown:{...tax_breakdown,total_tax:"0.00"}}})).toThrow();
  expect(()=>documentTaxBreakdownFromSnapshot({...input,snapshot:{tax_breakdown:null}})).toThrow();
 });
});
