import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({preview:vi.fn(),create:vi.fn(),list:vi.fn(),cancel:vi.fn()}));
vi.mock('../module/livraisons/services/delivery-urgency.service',()=>({svcPreviewDeliveryUrgency:mocks.preview,
  svcCreateDeliveryUrgencyRequest:mocks.create,svcListDeliveryUrgencyRequests:mocks.list,svcCancelDeliveryUrgencyRequest:mocks.cancel}));
import { previewDeliveryUrgency,createDeliveryUrgencyRequest,listDeliveryUrgencyRequests,cancelDeliveryUrgencyRequest }
  from '../module/livraisons/controllers/delivery-urgency.controller';
import { validationErrorMiddleware } from '../module/auth/middlewares/validationError.middleware';
const id='a130702e-eb6b-4d73-a403-134f7c67d023',key='7056b178-3d6e-4658-8f86-410e3b813ca7';
const body={quantity:'0.5',preview_hash:'a'.repeat(64),reason:'Demande urgente du client'};
function app(){
  const server=express();server.use(express.json());server.use((req,_res,next)=>{
    if(req.get('x-recipe-user'))req.user={id:8,role:'Stock'} as Express.User;next();
  });
  server.get('/allocations/:allocationId/preview',previewDeliveryUrgency);
  server.get('/allocations/:allocationId/requests',listDeliveryUrgencyRequests);
  server.post('/allocations/:allocationId/requests',createDeliveryUrgencyRequest);
  server.post('/requests/:requestId/cancel',cancelDeliveryUrgencyRequest);
  server.use(validationErrorMiddleware);server.use(((error,_req,res,_next)=>res.status(error.status??500).json({code:error.code})) as ErrorRequestHandler);
  return server;
}
beforeEach(()=>{vi.clearAllMocks();mocks.preview.mockResolvedValue({can_withdraw:false});mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({request:{id,can_withdraw:false},replayed:false});mocks.cancel.mockResolvedValue({request:{id,status:'CANCELLED'}});});
describe('urgency HTTP input boundaries',()=>{
  it('requires an authenticated user for every handler',async()=>{
    const server=app();
    expect((await request(server).get('/allocations/1/preview')).status).toBe(401);
    expect((await request(server).get('/allocations/1/requests')).status).toBe(401);
    expect((await request(server).post('/allocations/1/requests').send(body)).status).toBe(401);
    expect((await request(server).post(`/requests/${id}/cancel`).send({expected_version:1,reason:body.reason})).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each([undefined,'not-an-uuid'])('rejects an absent or invalid request key before database access: %s',async value=>{
    let call=request(app()).post('/allocations/1/requests').set('x-recipe-user','present');
    if(value)call=call.set('Idempotency-Key',value);
    expect((await call.send(body)).status).toBe(400);expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects a forged approval or withdrawal flag',async()=>{
    expect((await request(app()).post('/allocations/1/requests').set('x-recipe-user','present').set('Idempotency-Key',key)
      .send({...body,status:'APPROVED',can_withdraw:true})).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('preserves decimal quantities and returns the newly created request without caching',async()=>{
    const response=await request(app()).post('/allocations/1/requests').set('x-recipe-user','present').set('Idempotency-Key',key).send(body);
    expect(response.status).toBe(201);expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({allocationId:1,body,idempotencyKey:key,audit:expect.objectContaining({user_id:8})}));
  });
  it('returns 200 when a repeated request was already saved',async()=>{
    mocks.create.mockResolvedValue({request:{id},replayed:true});
    expect((await request(app()).post('/allocations/1/requests').set('x-recipe-user','present').set('Idempotency-Key',key).send(body)).status).toBe(200);
  });
  it('requires an explicit version and reason for cancellation',async()=>{
    const response=await request(app()).post(`/requests/${id}/cancel`).set('x-recipe-user','present').send({reason:body.reason});
    expect(response.status).toBe(400);expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
