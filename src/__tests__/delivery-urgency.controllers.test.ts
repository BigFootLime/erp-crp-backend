import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({preview:vi.fn(),create:vi.fn(),list:vi.fn(),cancel:vi.fn(),cancelPreview:vi.fn(),withdrawalPreview:vi.fn(),withdraw:vi.fn(),restore:vi.fn()}));
vi.mock('../module/livraisons/services/delivery-urgency.service',()=>({svcPreviewDeliveryUrgency:mocks.preview,
  svcCreateDeliveryUrgencyRequest:mocks.create,svcListDeliveryUrgencyRequests:mocks.list,svcCancelDeliveryUrgencyRequest:mocks.cancel,
  svcPreviewUrgencyCancellation:mocks.cancelPreview,svcPreviewUrgencyWithdrawal:mocks.withdrawalPreview,svcWithdrawDeliveryUrgency:mocks.withdraw,svcRestoreDeliveryUrgency:mocks.restore}));
import { previewDeliveryUrgency,createDeliveryUrgencyRequest,listDeliveryUrgencyRequests,cancelDeliveryUrgencyRequest,previewUrgencyWithdrawal,withdrawDeliveryUrgency,
  previewDeliveryUrgencyCancellation,cancelDeliveryUrgencyRetainingProduction,restoreDeliveryUrgency }
  from '../module/livraisons/controllers/delivery-urgency.controller';
import { validationErrorMiddleware } from '../module/auth/middlewares/validationError.middleware';
import { requirePlanningCapability } from '../module/planning/middlewares/planning-authorization.middleware';
const id='a130702e-eb6b-4d73-a403-134f7c67d023',key='7056b178-3d6e-4658-8f86-410e3b813ca7';
const body={quantity:'0.5',preview_hash:'a'.repeat(64),reason:'Demande urgente du client'};
function app(role='Stock'){
  const server=express();server.use(express.json());server.use((req,_res,next)=>{
    if(req.get('x-recipe-user'))req.user={id:8,role} as Express.User;next();
  });
  server.get('/allocations/:allocationId/preview',previewDeliveryUrgency);
  server.get('/allocations/:allocationId/requests',listDeliveryUrgencyRequests);
  server.post('/allocations/:allocationId/requests',createDeliveryUrgencyRequest);
  server.post('/requests/:requestId/cancel',cancelDeliveryUrgencyRequest);
  server.get('/requests/:requestId/cancellation-preview',previewDeliveryUrgencyCancellation);
  server.post('/planning/:requestId/cancel-retaining-production',requirePlanningCapability('manage_schedule'),cancelDeliveryUrgencyRetainingProduction);
  server.post('/planning/:requestId/restitute',requirePlanningCapability('manage_schedule'),restoreDeliveryUrgency);
  server.get('/requests/:requestId/withdrawal-preview',previewUrgencyWithdrawal);
  server.post('/requests/:requestId/withdraw',withdrawDeliveryUrgency);
  server.use(validationErrorMiddleware);server.use(((error,_req,res,_next)=>res.status(error.status??500).json({code:error.code})) as ErrorRequestHandler);
  return server;
}
beforeEach(()=>{vi.clearAllMocks();mocks.preview.mockResolvedValue({can_withdraw:false});mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({request:{id,can_withdraw:false},replayed:false});mocks.cancel.mockResolvedValue({request:{id,status:'CANCELLED'}});});
describe('urgency HTTP input boundaries',()=>{
  it.each([['Stock',true],['Operateur',false]] as const)('exposes the actual allocation capability for %s',async(role,allowed)=>{
    mocks.withdrawalPreview.mockResolvedValue({can_withdraw:false});
    const server=app(role);
    const preview=await request(server).get('/allocations/1/preview?quantity=20').set('x-recipe-user','present');
    const withdrawal=await request(server).get(`/requests/${id}/withdrawal-preview`).set('x-recipe-user','present');
    expect(preview.status).toBe(200);expect(preview.body.can_request).toBe(allowed);
    expect(withdrawal.status).toBe(200);expect(withdrawal.body.can_allocate).toBe(allowed);
  });
  it('requires an authenticated user for every handler',async()=>{
    const server=app();
    expect((await request(server).get('/allocations/1/preview')).status).toBe(401);
    expect((await request(server).get('/allocations/1/requests')).status).toBe(401);
    expect((await request(server).post('/allocations/1/requests').send(body)).status).toBe(401);
    expect((await request(server).post(`/requests/${id}/cancel`).send({expected_version:1,reason:body.reason})).status).toBe(401);
    expect((await request(server).get(`/requests/${id}/withdrawal-preview`)).status).toBe(401);
    expect((await request(server).post(`/requests/${id}/withdraw`).send({expected_version:2,preview_hash:body.preview_hash})).status).toBe(401);
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
  it('does not let logistics retain production commitments without planning permission',async()=>{
    const response=await request(app('Stock')).post(`/planning/${id}/cancel-retaining-production`).set('x-recipe-user','present')
      .send({expected_version:1,reason:body.reason,preview_hash:body.preview_hash});
    expect(response.status).toBe(403);expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('requires reviewed commitments on the planner route',async()=>{
    const response=await request(app('Planning')).post(`/planning/${id}/cancel-retaining-production`).set('x-recipe-user','present')
      .send({expected_version:1,reason:body.reason});
    expect(response.status).toBe(400);expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('records the explicit planner decision separately from ordinary cancellation',async()=>{
    const response=await request(app('Planning')).post(`/planning/${id}/cancel-retaining-production`).set('x-recipe-user','present')
      .send({expected_version:1,reason:body.reason,preview_hash:body.preview_hash});
    expect(response.status).toBe(200);expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({retainProduction:true}));
  });
  it('rejects a forged retention flag on the logistics route',async()=>{
    const response=await request(app()).post(`/requests/${id}/cancel`).set('x-recipe-user','present')
      .send({expected_version:1,reason:body.reason,retainProduction:true});
    expect(response.status).toBe(400);expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('shows cancellation review even when supply approval cannot be calculated',async()=>{
    mocks.cancelPreview.mockResolvedValue({can_cancel:true,requires_planner:true});
    const response=await request(app()).get(`/requests/${id}/cancellation-preview`).set('x-recipe-user','present');
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.withdrawalPreview).not.toHaveBeenCalled();
  });
  it('requires planner permission and explicit retained fee for restitution',async()=>{
    const payload={expected_version:3,reason:body.reason,preview_hash:body.preview_hash,fee_decision:'KEEP'};
    expect((await request(app()).post(`/planning/${id}/restitute`).send(payload)).status).toBe(401);
    expect((await request(app('Stock')).post(`/planning/${id}/restitute`).set('x-recipe-user','present').set('Idempotency-Key',key).send(payload)).status).toBe(403);
    expect((await request(app('Planning')).post(`/planning/${id}/restitute`).set('x-recipe-user','present').set('Idempotency-Key',key).send({...payload,fee_decision:undefined})).status).toBe(400);
    expect((await request(app('Planning')).post(`/planning/${id}/restitute`).set('x-recipe-user','present').send(payload)).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it.each([false,true])('returns the committed restitution, replay=%s',async replayed=>{
    mocks.restore.mockResolvedValue({request:{id,status:'CANCELLED'},replayed});
    const payload={expected_version:3,reason:body.reason,preview_hash:body.preview_hash,fee_decision:'KEEP'};
    const response=await request(app('Planning')).post(`/planning/${id}/restitute`).set('x-recipe-user','present').set('Idempotency-Key',key).send(payload);
    expect(response.status).toBe(replayed?200:201);expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({requestId:id,body:payload,idempotencyKey:key}));
  });
  it.each([
    {}, {expected_version:0,preview_hash:body.preview_hash}, {expected_version:2,preview_hash:'bad'},
    {expected_version:2,preview_hash:body.preview_hash,quantity:'999'},
  ])('rejects invalid withdrawal data before accessing stock: %j',async payload=>{
    expect((await request(app()).post(`/requests/${id}/withdraw`).set('x-recipe-user','present').set('Idempotency-Key',key).send(payload)).status).toBe(400);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
  it('requires a withdrawal replay key',async()=>{
    expect((await request(app()).post(`/requests/${id}/withdraw`).set('x-recipe-user','present')
      .send({expected_version:2,preview_hash:body.preview_hash})).status).toBe(400);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
  it.each([false,true])('returns the saved withdrawal with private caching, replay=%s',async replayed=>{
    mocks.withdraw.mockResolvedValue({withdrawal:{id,status:'WITHDRAWN'},replayed});
    const response=await request(app()).post(`/requests/${id}/withdraw`).set('x-recipe-user','present').set('Idempotency-Key',key)
      .send({expected_version:2,preview_hash:body.preview_hash});
    expect(response.status).toBe(replayed?200:201);expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.objectContaining({requestId:id,expectedVersion:2,previewHash:body.preview_hash,idempotencyKey:key,audit:expect.objectContaining({user_id:8})}));
  });
});
