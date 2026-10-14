import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),commitError:{} as unknown}));
vi.mock("../../../config/database",()=>({default:{query:mocks.query,connect:async()=>({query:mocks.query,release:mocks.release})}}));
vi.mock("./workflow.repository.shared",()=>({
  acquireFinanceIdempotency:async()=>({idempotencyKey:"fixture-amount-key",requestHash:"a".repeat(64),replay:null}),
  nextLegacyId:async()=>12,newCorrelationId:()=>"12680000-0000-4000-8000-000000000099",
  insertFinanceEvent:async()=>{},insertGlobalFinanceAudit:async()=>{},saveFinanceReceipt:async()=>{},
}));
import { repoCreateAvoirDraft,repoPreviewAvoir } from "./avoir-workflow.repository";
const input={facture_id:42,reason_code:"OTHER" as const,reason:"Correction de recette",lines:[{facture_line_id:1,advance_amount_ex_tax:"33.33"}]};
const row={facture_id:"42",facture_number:"ADV-42",facture_status:"ISSUED",facture_document_status:"ISSUED",client_id:"fixture",currency:"EUR",
 client_snapshot:{},issuer_snapshot:{},legal_entity_code:"FIXTURE",facture_line_id:"1",line_order:1,designation:"Acompte",code_piece:null,
 quantity_invoiced:"1.000",quantity_already_credited:"0.000",unit:"acompte",unit_price_ex_tax:"100.0000",discount_percent:"0.0000",tax_rate_percent:"20.0000",
 original_snapshot:{invoice_type_code:386},original_net:"100.00",original_tax:"20.00",original_gross:"120.00",
 document_net:"100.00",document_tax:"20.00",document_gross:"120.00",original_global_discount_percent:"0.0000",
 credited_net:"0.00",credited_tax:"0.00",credited_gross:"0.00",is_advance_source:true};
beforeEach(()=>{
 mocks.query.mockReset();mocks.release.mockReset();
 mocks.query.mockImplementation(async(sql:string)=>{
  if(sql==="COMMIT")throw mocks.commitError;
  if(sql.includes("JOIN public.facture_ligne fl"))return{rows:[row]};
  if(sql.includes("RETURNING id::text AS id"))return{rows:[{id:"1"}]};
  return{rows:[]};
 });
});
describe("monetary draft commit conflicts",()=>{
 it("rolls back a deferred budget conflict and returns an actionable business 409",async()=>{
  mocks.commitError={code:"23514",message:"ADVANCE-AMOUNT-1268 cumulative draft and issued credits exceed the original line budget"};
  const preview=await repoPreviewAvoir(input);
  await expect(repoCreateAvoirDraft({actor:{userId:7},idempotencyKey:"fixture-amount-key",input:{...input,preview_hash:preview.preview_hash}}))
   .rejects.toMatchObject({status:409,code:"AVOIR_ADVANCE_AMOUNT_CONFLICT"});
  expect(mocks.query.mock.calls.some(([sql])=>sql==="ROLLBACK")).toBe(true);expect(mocks.release).toHaveBeenCalledOnce();
 });
 it("keeps an unrelated failure visible to the server error handler",async()=>{
  mocks.commitError=new Error("Unrelated commit transport failure");
  const preview=await repoPreviewAvoir(input);
  await expect(repoCreateAvoirDraft({actor:{userId:7},idempotencyKey:"fixture-amount-key",input:{...input,preview_hash:preview.preview_hash}})).rejects.toBe(mocks.commitError);
  expect(mocks.release).toHaveBeenCalledOnce();
 });
});
