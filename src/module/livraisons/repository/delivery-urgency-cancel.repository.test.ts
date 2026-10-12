import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),ofAudit:vi.fn(),audit:vi.fn(),read:vi.fn(),review:vi.fn(),event:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn(async()=>({query:mocks.query,release:mocks.release}))}}));
vi.mock('../../production/repository/production-preparation.repository',()=>({preparationAudit:mocks.ofAudit}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));
vi.mock('./delivery-urgency-request.repository',()=>({readUrgencyRequests:mocks.read}));
vi.mock('./delivery-urgency-cancellation-preview.repository',()=>({readUrgencyCancellationTx:mocks.review}));
vi.mock('../../../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:mocks.event}));
import { repoCancelDeliveryUrgencyRequest } from './delivery-urgency-cancel.repository';
const args={requestId:'r1',body:{expected_version:1,reason:'Urgence annulée par le client'},audit:{user_id:8,ip:null,user_agent:null,
  device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null}};
let status:string,retained:boolean,review:ReturnType<typeof makeReview>;
function makeReview(){return {request:{id:'r1',version:1,status:'WAITING_PLANNER',commande_id:4},tree:[{id:101,statut:'BROUILLON'},{id:102,statut:'BROUILLON'}],
  response:{can_cancel:true,requires_planner:false,preview_hash:'a'.repeat(64),issues:[] as Array<{code:string;message:string}>}};}
beforeEach(()=>{
  vi.clearAllMocks();status='WAITING_PLANNER';retained=false;review=makeReview();
  mocks.review.mockImplementation(async()=>review);
  mocks.read.mockResolvedValue([{id:'r1',status:'CANCELLED',version:2,can_withdraw:false}]);
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT beneficiary_allocation_id')?
    [{beneficiary_allocation_id:1,status,version:status==='CANCELLED'?2:1,cancelled_by:status==='CANCELLED'?8:null,
      cancellation_reason:status==='CANCELLED'?args.body.reason:null,cancellation_retains_production:status==='CANCELLED'?retained:null}]:[]}));
});
const writes=()=>mocks.query.mock.calls.filter(([sql])=>/^(UPDATE|DELETE)/.test(sql));
describe('reviewed urgency cancellation',()=>{
  it('cancels untouched drafts without moving donor reservations and notifies the modules',async()=>{
    expect(await repoCancelDeliveryUrgencyRequest(args)).toMatchObject({request:{status:'CANCELLED'},replayed:false});
    expect(writes()).toHaveLength(3);expect(writes().some(([sql])=>sql.includes('stock_reservations'))).toBe(false);
    expect(mocks.event).toHaveBeenCalledOnce();expect(mocks.ofAudit).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('requires explicit planner retention for prepared or grouped production',async()=>{
    review.response.requires_planner=true;
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_RECOVERY_ENGAGED'});
    expect(writes()).toHaveLength(0);
  });
  it('locks the whole recovery tree before checking newly committed preparation',async()=>{
    mocks.review.mockImplementationOnce(async()=>{
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY of.id FOR UPDATE'),['r1']);
      return {...review,response:{...review.response,requires_planner:true}};
    });
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_RECOVERY_ENGAGED'});
    expect(writes()).toHaveLength(0);
  });
  it.each(['WAITING_PLANNER','APPROVED'])('retains all operations, reservations and groups for %s',async s=>{
    status=s;review.response.requires_planner=true;review.tree[0].statut='EN_COURS';
    await repoCancelDeliveryUrgencyRequest({...args,retainProduction:true,body:{...args.body,preview_hash:review.response.preview_hash}});
    expect(writes()).toHaveLength(1);expect(writes()[0][0]).toContain('UPDATE public.delivery_urgency_requests');
    expect(writes()[0][1][3]).toBe(true);expect(JSON.parse(writes()[0][1][4])).toMatchObject({tree:review.tree});
    expect(writes()[0][0]).not.toContain('approved_id=');
  });
  it.each([undefined,'b'.repeat(64)])('requires the exact reviewed engagements: %s',async preview_hash=>{
    await expect(repoCancelDeliveryUrgencyRequest({...args,retainProduction:true,body:{...args.body,preview_hash}}))
      .rejects.toMatchObject({code:'URGENCY_CANCELLATION_CHANGED'});expect(writes()).toHaveLength(0);
  });
  it('does not cancel after stock withdrawal',async()=>{
    status='WITHDRAWN';await expect(repoCancelDeliveryUrgencyRequest({...args,retainProduction:true}))
      .rejects.toMatchObject({code:'URGENCY_REQUEST_CHANGED'});expect(writes()).toHaveLength(0);
  });
  it.each([false,true])('replays cancellation without repeating writes, retention=%s',async retainProduction=>{
    status='CANCELLED';retained=retainProduction;
    expect(await repoCancelDeliveryUrgencyRequest({...args,retainProduction})).toMatchObject({replayed:true});
    expect(mocks.review).not.toHaveBeenCalled();expect(writes()).toHaveLength(0);
  });
  it('never replays a different retention decision',async()=>{
    status='CANCELLED';retained=true;
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_REQUEST_CHANGED'});
  });
  it('rolls back the whole decision when the notification fails',async()=>{
    mocks.event.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toThrow('outbox unavailable');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('turns concurrent changes into an actionable conflict',async()=>{
    mocks.review.mockRejectedValueOnce({code:'40001'});
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toMatchObject({status:409,code:'URGENCY_CANCELLATION_BUSY'});
  });
});
