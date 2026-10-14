import { describe,expect,it } from "vitest";
import { originalInvoiceCreditBudgets,originalInvoiceLineCredit,originalCreditEffectiveDiscount,type OriginalCreditLine } from "./invoice-credit-budget";
const line=(override:Partial<OriginalCreditLine>={}):OriginalCreditLine=>({id:"1",quantity:"3.000",net:"100.00",tax:"20.00",gross:"120.00",rate:"20",discount:"0",
 creditedQuantity:"0.000",creditedNet:"0.00",creditedTax:"0.00",creditedGross:"0.00",...override});
describe("credits retain original document values",()=>{
 it("credits a discounted VAT category without repricing the invoice",()=>{
  const a=line(),b=line({id:"2",rate:"5.5",tax:"5.50",gross:"105.50"});
  const budgets=originalInvoiceCreditBudgets({snapshot:{},lines:[a,b],net:"190.00",tax:"24.23",gross:"214.23"});
  expect(originalInvoiceLineCredit(a,budgets.get("1")!,"3")).toEqual({net:"95.00",tax:"19.00",gross:"114.00"});
  expect(originalInvoiceLineCredit(b,budgets.get("2")!,"3")).toEqual({net:"95.00",tax:"5.23",gross:"100.23"});
 });
 it("successive thirds return exactly the original discounted net, tax and gross",()=>{
  const budget={net:9500n,tax:1900n,gross:11400n};
  const first=originalInvoiceLineCredit(line(),budget,"1");
  const second=originalInvoiceLineCredit(line({creditedQuantity:"1",creditedNet:first.net,creditedTax:first.tax,creditedGross:first.gross}),budget,"1");
  const last=originalInvoiceLineCredit(line({creditedQuantity:"2",creditedNet:"63.33",creditedTax:"12.67",creditedGross:"76.00"}),budget,"1");
  expect([first,second,last]).toEqual([{net:"31.67",tax:"6.33",gross:"38.00"},{net:"31.66",tax:"6.34",gross:"38.00"},{net:"31.67",tax:"6.33",gross:"38.00"}]);
 });
 it("combines line and document allowances multiplicatively, exactly once",()=>{
  expect(originalCreditEffectiveDiscount("10","5")).toBe("14.5000");
  expect(originalCreditEffectiveDiscount("5","5")).toBe("9.7500");
  expect(originalCreditEffectiveDiscount("0","0")).toBe("0.0000");
  expect(originalCreditEffectiveDiscount("99.9999","0.1234")).toBe("99.9999");
 });
 it("retains line-rounded historical VAT categories",()=>{
  const lines=[line({net:"3.00",tax:"1.00",gross:"4.00"}),line({id:"2",rate:"5.5",net:"10.00",tax:"0.55",gross:"10.55"})];
  expect([...originalInvoiceCreditBudgets({snapshot:{},lines,net:"13.00",tax:"1.55",gross:"14.55"}).values()]).toEqual([
   {net:1000n,tax:55n,gross:1055n},{net:300n,tax:100n,gross:400n},
  ]);
 });
 it("handles free lines and a complete original allowance without inventing money",()=>{
  const original=line({net:"0.00",tax:"0.00",gross:"0.00"});
  const budgets=originalInvoiceCreditBudgets({snapshot:{},lines:[original],net:"0.00",tax:"0.00",gross:"0.00"});
  expect(originalInvoiceLineCredit(original,budgets.get("1")!,"3")).toEqual({net:"0.00",tax:"0.00",gross:"0.00"});
  expect(originalCreditEffectiveDiscount("0","100")).toBe("100.0000");
 });
 it.each([{creditedGross:"1.00"},{creditedNet:"96.00",creditedGross:"96.00"},{creditedTax:"-0.01",creditedGross:"-0.01"}])("blocks inconsistent or exhausted credit evidence %j",prior=>{
  expect(()=>originalInvoiceLineCredit(line(prior),{net:9500n,tax:1900n,gross:11400n},"1")).toThrow();
 });
 it.each(["0","-1","4"])('refuses an invalid or excessive selected quantity %s',qty=>{
  expect(()=>originalInvoiceLineCredit(line(),{net:9500n,tax:1900n,gross:11400n},qty)).toThrow();
 });
 it("never accepts contradictory originals or a modified frozen VAT model",()=>{
  expect(()=>originalInvoiceCreditBudgets({snapshot:{tax_breakdown:null},lines:[line()],net:"95.00",tax:"19.00",gross:"114.00"})).toThrow();
  expect(()=>originalInvoiceCreditBudgets({snapshot:{},lines:[line({gross:"119.00"})],net:"100.00",tax:"20.00",gross:"120.00"})).toThrow();
 });
});
