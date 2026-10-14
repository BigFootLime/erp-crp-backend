import {describe,expect,it} from "vitest";
import {apportionExactCents,finalPrepaymentTargets} from "./final-prepayment-targets";
import type {FacturePreviewLine} from "../types/workflow.types";
const line=(id:string,gross:string,quantity="1.000"):FacturePreviewLine=>({source_type:"DELIVERY_LINE",source_id:"bl",source_line_id:id,
 designation:"Pièce",code_piece:"P",quantity,unit:"u",unit_price_ex_tax:"1.0000",discount_percent:"0.0000",tax_rate_percent:"20.0000",
 total_ex_tax:gross,tax_amount:"0.00",total_incl_tax:gross,pricing_version:"frozen",rule_code:"PROFORMA_FINAL_QUANTITY_V1",
 proforma_contributions:[{billing_part_id:"part-"+id,allocation_id:"1",quantity}]});
describe("#1268 document prepayment monetary targets",()=>{
 it("preserves a global-discount cent without charging a phantom remainder",()=>{
  expect(finalPrepaymentTargets([line("b","0.01"),line("a","0.01")],"0.01")).toEqual([
   {source_line_id:"b",billing_part_id:"part-b",amount_incl_tax:"0.00"},{source_line_id:"a",billing_part_id:"part-a",amount_incl_tax:"0.01"}]);
 });
 it("keeps an order charge outside goods advances while preserving the document total",()=>{
  const fee={...line("fee","20.00"),source_type:"ORDER_CHARGE" as const,proforma_contributions:undefined};
  expect(finalPrepaymentTargets([line("goods","100.00"),fee],"108.00")).toEqual([{source_line_id:"goods",billing_part_id:"part-goods",amount_incl_tax:"90.00"}]);
 });
 it("splits one physical invoice line across its exact retained affair contributions",()=>{
  const source={...line("a","1.00","3.000"),proforma_contributions:[{billing_part_id:"p-a",allocation_id:"1",quantity:"1.000"},{billing_part_id:"p-b",allocation_id:"2",quantity:"2.000"}]};
  expect(finalPrepaymentTargets([source],"1.00").map(t=>t.amount_incl_tax)).toEqual(["0.33","0.67"]);
 });
 it("keeps large exact amounts without floating-point conversion",()=>{
  expect([...apportionExactCents(999999999999999999n,[{key:"a",weight:1n},{key:"b",weight:1n}]).values()])
   .toEqual([500000000000000000n,499999999999999999n]);
 });
 it("refuses inconsistent or duplicate sources and accepts a genuinely free document",()=>{
  expect(()=>finalPrepaymentTargets([line("a","1.00"),line("a","1.00")],"2.00")).toThrow();
  expect(()=>finalPrepaymentTargets([{...line("a","1.00"),quantity:"2.000"}],"1.00")).toThrow();
  expect(finalPrepaymentTargets([line("a","0.00")],"0.00")[0]!.amount_incl_tax).toBe("0.00");
 });
});
