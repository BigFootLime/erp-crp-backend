import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ query:vi.fn(),release:vi.fn(),read:vi.fn(),quality:vi.fn() }));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn(async()=>({query:mocks.query,release:mocks.release}))}}));
vi.mock('./delivery-stock-recovery.repository',()=>({readDeliveryStockRecoveryPlan:mocks.read}));
vi.mock('../../qualite/repository/quality-operational-gate.repository',()=>({readOperationalLotQualityEligibility:mocks.quality}));
import { repoPreviewDeliveryUrgency } from './delivery-urgency.repository';
const row={reservation_id:'r1',allocation_id:2,client_id:'195',article_id:'a1',lane:'DELIVERY',
  version_compatible:true,protected_due_date:'2026-11-30',reservation_remaining:'4',prepared_quantity:'0',
  stock_batch_id:'b1',stock_level_id:'l1',batch_total:'4',batch_reserved:'4',batch_depreciated:'0',
  level_total:'4',level_reserved:'4',level_depreciated:'0',lot_id:'lot1',lot_status:'LIBERE',expiry_at:null,source_scope:'NEW'};
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({context:{client_id:'195',article_id:'a1',technical_version_id:'pt1',unit:'u'},
    plan:{reserved_quantity:'1'},preview:{lane_status:'ACTIVE',uncovered_qty:5,preview_hash:'hash',candidate_limit_reached:false}});
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes(' AS day')?[{day:'2026-10-12'}]:sql.includes('AS reservation_id')?[{...row}]:[]}));
  mocks.quality.mockResolvedValue({eligibility:{allowed:true,blocks:[]}});
});
describe('urgency read transaction',()=>{
  it('reads one repeatable snapshot and rechecks existing quality commitments without charging them twice',async()=>{
    const result=await repoPreviewDeliveryUrgency(1);
    expect(result).toMatchObject({free_quantity:'1',recovery_quantity:'4',can_withdraw:false});
    expect(mocks.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(mocks.quality).toHaveBeenCalledWith(expect.objectContaining({lotId:'lot1',qty:0,unit:'u',purpose:'RESERVE'}));
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql])=>/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
  it('does not count a donor whose current quality release was revoked',async()=>{
    mocks.quality.mockResolvedValue({eligibility:{allowed:false,blocks:[{message:'Libération retirée'}]}});
    expect(await repoPreviewDeliveryUrgency(1)).toMatchObject({recovery_quantity:'0',shortage_quantity:'4',
      donors:[expect.objectContaining({blocker:'Libération retirée',proposed_quantity:'0'})]});
  });
  it('requires the real physical lane configuration',async()=>{
    mocks.read.mockResolvedValue({context:{},preview:{lane_status:'CONFIGURING'}});
    await expect(repoPreviewDeliveryUrgency(1)).rejects.toMatchObject({code:'URGENCY_LANES_NOT_CONFIGURED'});
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('rolls back and releases the connection on a database failure',async()=>{
    mocks.read.mockRejectedValueOnce(new Error('unavailable'));
    await expect(repoPreviewDeliveryUrgency(1)).rejects.toThrow('unavailable');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(mocks.release).toHaveBeenCalledOnce();
  });
});
