import {describe,expect,it}from'vitest';
import {invoiceTypeCodeFromSnapshot}from'./invoice-kind';
describe('issued fiscal document kind',()=>{
 it('retains historical standard invoices without metadata',()=>{
  expect(invoiceTypeCodeFromSnapshot({})).toBe(380);expect(invoiceTypeCodeFromSnapshot(null)).toBe(380);
 });
 it('recognizes the frozen advance code without treating a proforma as a fiscal invoice',()=>{
  expect(invoiceTypeCodeFromSnapshot({invoice_type_code:'386'})).toBe(386);
  expect(()=>invoiceTypeCodeFromSnapshot({invoice_type_code:'PROFORMA'})).toThrow();
 });
});
