import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({context:vi.fn(),material:vi.fn(),components:vi.fn(),scope:vi.fn(),dependencies:vi.fn(),snapshot:vi.fn(),preview:vi.fn(),connect:vi.fn(),query:vi.fn(),release:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:mocks.connect}}));
vi.mock('./recovery-consolidation-context.repository',()=>({readRecoveryConsolidationContextTx:mocks.context}));
vi.mock('../../production/repository/recovery-consolidation-material.repository',()=>({readRecoveryConsolidationMaterialTx:mocks.material}));
vi.mock('../../production/repository/of-component-coverage.repository',()=>({readOfComponentCoverageTx:mocks.components}));
vi.mock('../../production/repository/urgency-recovery-scope.repository',()=>({readUrgencyRecoveryScopesTx:mocks.scope}));
vi.mock('./planning-central.repository',()=>({readCentralDependencies:mocks.dependencies,readCentralSnapshot:mocks.snapshot}));
vi.mock('../domain/recovery-consolidation-preview',()=>({previewRecoveryConsolidation:mocks.preview}));
import {previewRecoveryGrouping,readRecoveryConsolidationPreviewTx} from './recovery-consolidation-preview.repository';
const tx={query:mocks.query,release:mocks.release};
const context=()=>({context:{request_id:'request',request_version:1,request_status:'WAITING_PLANNER',grouping_state:'ACTIVE'},
  recovery:{id:2,number:'RECOVERY',covered:false},producer:{id:1,number:'PRODUCER'},
  deadlines:[{of_id:2,label:'donor',before:'2026-10-20T22:00:00.000Z'}],originalIdentityMatches:true,sameClientSources:true,issues:[]});
const material=()=>({producer:{dossierStatus:'COMPLETE',operations:[{id:'cut'}]},recovery:{dossierStatus:'COMPLETE',operations:[{id:'recut'}]},
  issues:[],ready:true,version:'material-v1',policy:{usedOrigins:['heat'],maximumLots:2},groups:[{source_ref:'need',missing:0,recovery_reservation_ids:['private-reservation']}]});
const snapshot=()=>({revision:'1',nextCursor:null,tasks:[{id:'op:cut',operationType:'DECOUPE',ofId:1,resourceIds:['machine:1'],version:'1'},
  {id:'op:recut',operationType:'DECOUPE',ofId:2,resourceIds:['machine:1'],version:'1'}],
  resources:[{id:'machine:1',capacityId:'physical:1',version:'v1'},{id:'poste:1',capacityId:'physical:1',version:'v1'},{id:'machine:2',capacityId:'physical:2',version:'v1'}],dependencies:[]});
beforeEach(()=>{vi.clearAllMocks();mocks.connect.mockResolvedValue(tx);mocks.context.mockResolvedValue(context());mocks.material.mockResolvedValue(material());
  mocks.components.mockImplementation(async(_tx,ofId)=>({ofId,ready:true,items:[],version:'v1'}));mocks.scope.mockResolvedValue([]);
  mocks.dependencies.mockResolvedValue([]);mocks.snapshot.mockImplementation(async()=>snapshot());
  mocks.preview.mockImplementation(({evidence,now})=>({read_only:true,feasible:!evidence.issues.length,issues:evidence.issues,changes:[],proposed_finish:now}));});
describe('coherent read-only recovery grouping proposal',()=>{
  it('loads all shared resource capacity, not just the selected machine',async()=>{
    await previewRecoveryGrouping('recovery','group');
    expect(mocks.snapshot.mock.calls[1][0]).toMatchObject({capacityResourceIds:['machine:1','poste:1']});
    expect(mocks.query.mock.calls.map(c=>c[0])).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('includes dependency closure and records source completeness',async()=>{
    mocks.dependencies.mockResolvedValue([{predecessorId:'program:1',successorId:'op:cut',releasedQuantity:0,transferQuantity:null,lagMinutes:0}]);
    const m=material();m.recovery.dossierStatus='INCOMPLETE';mocks.material.mockResolvedValue(m);
    await previewRecoveryGrouping('recovery','group');
    expect(mocks.snapshot.mock.calls[0][0].includeTaskIds).toEqual(expect.arrayContaining(['program:1','op:cut','op:recut']));
    expect(mocks.preview.mock.calls[0][0].evidence.recovery.ready).toBe(false);
  });
  it('surfaces quality-blocked components and a different pending recovery',async()=>{
    mocks.components.mockImplementation(async(_tx,ofId)=>({ofId,ready:false,items:[{missing:4,consumedQuantity:ofId===2?1:0}],version:'v1'}));
    mocks.scope.mockResolvedValue([{request_id:'another',status:'WAITING_PLANNER'}]);
    const result=await previewRecoveryGrouping('recovery','group');
    expect(result.feasible).toBe(false);expect(result.issues.map((i:{code:string})=>i.code)).toEqual(expect.arrayContaining([
      'GROUPING_COMPONENTS_MISSING','GROUPING_RECOVERY_PENDING','RECOVERY_COMPONENTS_CONSUMED']));
  });
  it('blocks truncated dependency reads and hides internal reservation identities',async()=>{
    mocks.snapshot.mockImplementationOnce(async()=>({...snapshot(),nextCursor:'more'}));
    const result=await previewRecoveryGrouping('recovery','group');
    expect(result.issues.map((i:{code:string})=>i.code)).toContain('GROUPING_SNAPSHOT_INCOMPLETE');
    expect(JSON.stringify(result)).not.toContain('private-reservation');
  });
  it('versions data changes without making a new clock instant invalidate the source evidence',async()=>{
    const first=await readRecoveryConsolidationPreviewTx(tx,'recovery','group','2026-10-12T08:00:00.000Z');
    const later=await readRecoveryConsolidationPreviewTx(tx,'recovery','group','2026-10-12T08:00:01.000Z');
    expect(later.preview_hash).toBe(first.preview_hash);expect(later.checked_at).not.toBe(first.checked_at);
    mocks.material.mockResolvedValue({...material(),version:'material-v2'});
    expect((await readRecoveryConsolidationPreviewTx(tx,'recovery','group','2026-10-12T08:00:01.000Z')).preview_hash).not.toBe(first.preview_hash);
  });
  it('rolls back and releases the connection on a read failure',async()=>{
    mocks.context.mockRejectedValue(new Error('read failed'));
    await expect(previewRecoveryGrouping('recovery','group')).rejects.toThrow('read failed');
    expect(mocks.query.mock.calls.map(c=>c[0])).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','ROLLBACK']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
