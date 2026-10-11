import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),ofAudit:vi.fn(),audit:vi.fn(),read:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn(async()=>({query:mocks.query,release:mocks.release}))}}));
vi.mock('../../production/repository/production-preparation.repository',()=>({preparationAudit:mocks.ofAudit}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));
vi.mock('./delivery-urgency-request.repository',()=>({readUrgencyRequests:mocks.read}));
import { repoCancelDeliveryUrgencyRequest } from './delivery-urgency-cancel.repository';
const args={requestId:'r1',body:{expected_version:1,reason:'Urgence annulée par le client'},audit:{user_id:8,ip:null,user_agent:null,
  device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null}};
let status:string,tree:Array<{id:number;statut:string;technical_snapshot_sha256:string|null}>,used:boolean;
beforeEach(()=>{
  vi.clearAllMocks();status='WAITING_PLANNER';used=false;tree=[{id:101,statut:'BROUILLON',technical_snapshot_sha256:null},
    {id:102,statut:'BROUILLON',technical_snapshot_sha256:null}];
  mocks.read.mockResolvedValue([{id:'r1',status:'CANCELLED',version:2,can_withdraw:false}]);
  mocks.query.mockImplementation(async(sql:string)=>({rows:
    sql.includes('SELECT beneficiary_allocation_id')?[{beneficiary_allocation_id:1,status,version:status==='CANCELLED'?2:1,
      cancelled_by:status==='CANCELLED'?8:null,cancellation_reason:status==='CANCELLED'?args.body.reason:null}]:
    sql.includes('SELECT recovery_of_id')?[{recovery_of_id:101}]:
    sql.includes('SELECT id::int,statut')?tree:sql.startsWith('SELECT 1 WHERE')&&used?[{used:true}]:[]}));
});
describe('cancel an untouched urgency preparation',()=>{
  it('cancels the whole draft tree and retains donor reservations and historical evidence',async()=>{
    expect(await repoCancelDeliveryUrgencyRequest(args)).toMatchObject({request:{status:'CANCELLED'},replayed:false});
    expect(mocks.ofAudit).toHaveBeenCalledTimes(2);
    const writes=mocks.query.mock.calls.filter(([sql])=>/^(UPDATE|DELETE)/.test(sql)).map(([sql])=>sql);
    expect(writes).toHaveLength(3); expect(writes.some(sql=>sql.includes('stock_reservations'))).toBe(false);
    expect(writes.some(sql=>sql.startsWith('DELETE'))).toBe(false);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(['PLANIFIE','EN_COURS','TERMINE'])('refuses to silently cancel an engaged child: %s',async statut=>{
    tree[1].statut=statut;
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_RECOVERY_ENGAGED'});
    expect(mocks.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
  });
  it('does not abandon a stock reservation or material requirement',async()=>{
    used=true;
    await expect(repoCancelDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_RECOVERY_ENGAGED'});
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('replays the same cancellation without another mutation',async()=>{
    status='CANCELLED';expect(await repoCancelDeliveryUrgencyRequest(args)).toMatchObject({replayed:true});
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
  });
  it('refuses a stale browser version',async()=>{
    await expect(repoCancelDeliveryUrgencyRequest({...args,body:{...args.body,expected_version:2}})).rejects.toMatchObject({code:'URGENCY_REQUEST_CHANGED'});
  });
});
