import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("./proforma-transaction.repository",()=>({runProformaCommand:async(args:{work:(tx:{query:typeof mocks.query},id:string)=>Promise<{result:Record<string,unknown>}>})=>
  ({...(await args.work({query:mocks.query},"qualification-receipt-correlation")).result,idempotent_replay:false})}));
import { repoAssignProformaReceipts,repoReleaseProformaReceipt } from "./proforma-receipts.repository";
const id="12680000-0000-4000-8000-000000000001",partId="12680000-0000-4000-8000-000000000002",sourceId="12680000-0000-4000-8000-000000000003",paymentId="12680000-0000-4000-8000-000000000004";
const context={id,actor:{userId:7,requestId:"qualification",path:"/proformas"},idempotencyKey:"qualification-assignment"};
const input={payment_allocation_id:paymentId,assignments:[{proforma_billing_part_id:partId,deposit_source_id:sourceId,amount:"20.00"}]};
let document:{id:string;reference:string;status:string;row_version:number;currency:string};
let payment:{facture_id:string;amount:string;client_id:string;currency:string;status:string;workflow_status:string;reversal_of_id:string|null};
let invoice:{document_status:string;client_id:string;currency:string};
let targets:Array<{id:string;source_id:string;allocation_id:string;billed_client_id:string;amount:string;allocation_status:string;source_type:string}>;
let parentUsed:string,sourceUsed:string,assignment:{id:string;allocation_id:string;amount:string;released:string}|null;
beforeEach(()=>{
 document={id,reference:"PF-QUAL",status:"ISSUED",row_version:2,currency:"EUR"};
 payment={facture_id:"1",amount:"100.00",client_id:"902",currency:"EUR",status:"ALLOCATED",workflow_status:"ALLOCATED",reversal_of_id:null};
 invoice={document_status:"ISSUED",client_id:"902",currency:"EUR"};
 targets=[{id:partId,source_id:sourceId,allocation_id:"12",billed_client_id:"902",amount:"100.00",allocation_status:"CONSUMED",source_type:"DEPOSIT"}];
 parentUsed="0.00";sourceUsed="0.00";assignment={id:"assignment",allocation_id:"12",amount:"100.00",released:"20.00"};
 mocks.query.mockReset();mocks.query.mockImplementation(async(sql:string)=>{
  if(sql.includes("FROM public.proforma_client"))return{rows:[document]};
  if(sql.includes("FROM public.paiement_allocations allocation"))return{rows:[payment]};
  if(sql.includes("SELECT document_status,client_id::text,currency"))return{rows:[invoice]};
  if(sql.includes("SELECT part.id::text,source.id::text"))return{rows:targets};
  if(sql.includes("SELECT receipt.id::text,line.allocation_id"))return{rows:assignment?[assignment]:[]};
  if(sql.includes("GROUP BY receipt.deposit_source_id"))return{rows:[{source_id:sourceId,amount:sourceUsed}]};
  if(sql.includes("WHERE receipt.payment_allocation_id"))return{rows:[{amount:parentUsed}]};
  return{rows:[]};
 });
});
const wroteAssignment=()=>mocks.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO public.proforma_receipt_assignments"));
describe("ventilation of existing allocated receipts",()=>{
 it("does not assign cash to a draft proforma",async()=>{
  document.status="DRAFT";
  await expect(repoAssignProformaReceipts({...context,input})).rejects.toMatchObject({code:"PROFORMA_NOT_ISSUED"});expect(wroteAssignment()).toBe(false);
 });
 it.each(["REVERSED","REJECTED"])("rejects an unavailable %s payment",async status=>{
  payment.status=status;
  await expect(repoAssignProformaReceipts({...context,input})).rejects.toMatchObject({code:"PROFORMA_PAYMENT_NOT_AVAILABLE"});expect(wroteAssignment()).toBe(false);
 });
 it("requires an issued invoice from the company that actually paid",async()=>{
  invoice.client_id="903";
  await expect(repoAssignProformaReceipts({...context,input})).rejects.toMatchObject({code:"PROFORMA_DEPOSIT_NOT_ISSUED"});expect(wroteAssignment()).toBe(false);
 });
 it("does not use another party's or proforma's deposit binding",async()=>{
  targets[0]!.billed_client_id="903";
  await expect(repoAssignProformaReceipts({...context,input})).rejects.toMatchObject({code:"PROFORMA_RECEIPT_TARGET_MISMATCH"});expect(wroteAssignment()).toBe(false);
 });
 it("checks the remaining parent cash before any receipt is inserted",async()=>{
  parentUsed="90.00";
  await expect(repoAssignProformaReceipts({...context,input})).rejects.toMatchObject({code:"PROFORMA_RECEIPT_BUDGET_EXCEEDED"});expect(wroteAssignment()).toBe(false);
 });
 it("also checks deposit coverage independently from parent cash",async()=>{
  sourceUsed="90.00";
  await expect(repoAssignProformaReceipts({...context,input})).rejects.toMatchObject({code:"PROFORMA_DEPOSIT_RECEIPT_EXCEEDED"});expect(wroteAssignment()).toBe(false);
 });
 it("writes linked evidence without creating a second payment or updating the issued proforma",async()=>{
  const result=await repoAssignProformaReceipts({...context,input});
  expect(result).toMatchObject({id,status:"ISSUED",row_version:2,payment_allocation_id:paymentId,assignments:[{deposit_source_id:sourceId,amount:"20.00"}]});
  const insert=mocks.query.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO public.proforma_receipt_assignments"));
  expect(insert?.[1]).toEqual([expect.any(String),paymentId,sourceId,"20.00",7,"qualification-receipt-correlation"]);
  expect(mocks.query.mock.calls.some(([sql])=>/INSERT INTO public.paiement\b|UPDATE public.proforma_client/.test(String(sql)))).toBe(false);
 });
 it("retains a partial release as new evidence, without refunding cash",async()=>{
  const result=await repoReleaseProformaReceipt({...context,assignmentId:"12680000-0000-4000-8000-000000000010",input:{amount:"20.00",reason:"Régularisation de la ventilation",confirm:true}});
  expect(result).toMatchObject({released_amount:"20.00",status:"ISSUED"});
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO public.proforma_receipt_releases"))).toBe(true);
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE")||String(sql).startsWith("DELETE"))).toBe(false);
 });
 it("refuses releasing more than the remaining link",async()=>{
  await expect(repoReleaseProformaReceipt({...context,assignmentId:sourceId,input:{amount:"80.01",reason:"Régularisation de la ventilation",confirm:true}})).rejects.toMatchObject({code:"PROFORMA_RECEIPT_RELEASE_EXCEEDED"});
 });
 it("cannot release an assignment outside the selected proforma",async()=>{
  assignment=null;
  await expect(repoReleaseProformaReceipt({...context,assignmentId:sourceId,input:{amount:"20.00",reason:"Régularisation de la ventilation",confirm:true}})).rejects.toMatchObject({code:"PROFORMA_RECEIPT_NOT_FOUND"});
 });
});
