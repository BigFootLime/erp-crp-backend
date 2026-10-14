import express from "express";
import request from "supertest";
import { ZodError } from "zod";
import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({preview:vi.fn(),register:vi.fn(),previewReversal:vi.fn(),registerReversal:vi.fn(),list:vi.fn()}));
vi.mock("../services/customer-refund.service",()=>({svcPreviewCustomerRefund:mocks.preview,svcRegisterCustomerRefund:mocks.register,svcListCustomerRefunds:mocks.list}));
vi.mock("../services/customer-refund-reversal.service",()=>({svcPreviewCustomerRefundReversal:mocks.previewReversal,svcReverseCustomerRefund:mocks.registerReversal}));
import router from "./paiements.routes";
function app(){
  const server=express();server.use(express.json());
  server.use((req,_res,next)=>{const role=req.headers['x-test-role'];if(typeof role==='string')req.user={id:7,username:'fixture',email:'fixture@test.invalid',role};next();});
  server.use('/paiements',router);
  server.use(((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const value=error as {status?:number;code?:string};res.status(error instanceof ZodError?400:value.status??500).json({code:value.code??'VALIDATION_ERROR'});
  }) as express.ErrorRequestHandler);return server;
}
const body={avoir_id:1,amount:'60.00',preview_hash:'a'.repeat(64),confirm:true,value_date:'2026-10-14',booking_date:'2026-10-14',
  mode:'VIREMENT',reference:'FIXTURE-NO-BANK-TRANSFER',reason:'Preuve synthétique de qualification'};
describe("refund workflow HTTP authorization and typed inputs",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.preview.mockResolvedValue({maximum_amount:'60.00'});mocks.register.mockResolvedValue({id:'fixture',idempotent_replay:false});
  mocks.previewReversal.mockResolvedValue({amount:'60.00'});mocks.registerReversal.mockResolvedValue({id:'correction-fixture',idempotent_replay:false});mocks.list.mockResolvedValue({items:[]});});
 it.each([undefined,'Secretaire','Tourneur'])('protects refund history for %s',async role=>{
  const call=request(app()).get('/paiements/workflow/refunds?avoir_id=42');if(role)call.set('x-test-role',role);
  expect((await call).status).toBe(role?403:401);expect(mocks.list).not.toHaveBeenCalled();
 });
 it('lists original and corrected facts for one selected credit with typed filters',async()=>{
  expect((await request(app()).get('/paiements/workflow/refunds?avoir_id=42').set('x-test-role','Comptable')).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({avoir_id:42});mocks.list.mockClear();
  for(const query of ['avoir_id=other','avoir_id=0','avoir_id=42&client_id=another-company'])
   expect((await request(app()).get('/paiements/workflow/refunds?'+query).set('x-test-role','Comptable')).status).toBe(400);
  expect(mocks.list).not.toHaveBeenCalled();
 });
 it.each([undefined,'Secretaire','Tourneur'])('refuses unauthorized refund reads and records for %s',async role=>{
   for(const endpoint of ['preview','register']){const call=request(app()).post('/paiements/workflow/refunds/'+endpoint);
     if(role)call.set('x-test-role',role);const response=await call.send(endpoint==='preview'?{avoir_id:1}:body);
     expect(response.status).toBe(role?403:401);}
   expect(mocks.preview).not.toHaveBeenCalled();expect(mocks.register).not.toHaveBeenCalled();
 });
 it('lets one qualified accounting actor preview and record with a replay key',async()=>{
   expect((await request(app()).post('/paiements/workflow/refunds/preview').set('x-test-role','Comptable').send({avoir_id:1})).status).toBe(200);
   expect((await request(app()).post('/paiements/workflow/refunds/register').set('x-test-role','Comptable').set('Idempotency-Key','refund-fixture-key').send(body)).status).toBe(201);
   expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({actor:expect.objectContaining({userId:7}),idempotencyKey:'refund-fixture-key'}));
 });
 it('refuses nonexistent calendar dates and client/source overrides before accessing storage',async()=>{
   for(const input of [{...body,value_date:'2026-02-31'},{...body,client_id:'another-company'},{...body,payment_id:2},{...body,amount:'0.00'}]){
     expect((await request(app()).post('/paiements/workflow/refunds/register').set('x-test-role','Comptable').send(input)).status).toBe(400);
   }expect(mocks.register).not.toHaveBeenCalled();
 });
 it.each([undefined,'Secretaire','Tourneur'])('protects correction reads and writes for %s',async role=>{
   for(const endpoint of ['preview','register']){const call=request(app()).post('/paiements/workflow/refunds/reversals/'+endpoint);
     if(role)call.set('x-test-role',role);expect((await call.send({refund_id:'12680000-0000-4000-8000-000000000001'})).status).toBe(role?403:401);}
   expect(mocks.previewReversal).not.toHaveBeenCalled();expect(mocks.registerReversal).not.toHaveBeenCalled();
 });
 it('allows the same qualified accountant to correct once and replay without a second actor',async()=>{
   const correction={refund_id:'12680000-0000-4000-8000-000000000001',preview_hash:body.preview_hash,confirm:true,
     value_date:body.value_date,booking_date:body.booking_date,reference:body.reference,reason:body.reason};
   expect((await request(app()).post('/paiements/workflow/refunds/reversals/preview').set('x-test-role','Comptable')
     .send({refund_id:correction.refund_id})).status).toBe(200);
   const send=()=>request(app()).post('/paiements/workflow/refunds/reversals/register').set('x-test-role','Comptable')
     .set('Idempotency-Key','correction-fixture-key').send(correction);
   expect((await send()).status).toBe(201);
   expect(mocks.registerReversal).toHaveBeenCalledWith(expect.objectContaining({actor:expect.objectContaining({userId:7}),idempotencyKey:'correction-fixture-key'}));
   mocks.registerReversal.mockResolvedValue({id:'correction-fixture',idempotent_replay:true});expect((await send()).status).toBe(200);
 });
});
