import { describe,expect,it } from 'vitest';
import { previewRecoveryConsolidation,type RecoveryGroupingEvidence } from './recovery-consolidation-preview';
import { estimateDuration } from './central-estimation';
import type { CentralTask,CentralSnapshot } from '../types/planning-central.types';

const at=(h:number)=>`2026-10-12T${String(h).padStart(2,'0')}:00:00.000Z`,now=at(8);
function task(id:string,ofId:number,phase:number,patch:Partial<CentralTask>={}):CentralTask {
  const quantity=ofId===1?100:10;
  return {id:`op:${id}`,source:'OPERATION',operationId:id,programmingId:null,ofId,orderId:12,clientId:'customer',
    ofNumber:`OF-${ofId}`,reference:'REF',revision:'A',label:id,phase,operationType:phase===10?'DECOUPE':'FRAISAGE',
    view:phase===10?'cutting':'machines',internal:false,internalPurpose:null,quantity,good:0,scrap:0,rework:0,released:0,
    resourceIds:['machine:1'],eligibleResourceIds:['machine:1'],committed:ofId===1?{start:at(8),end:at(10)}:null,
    forecast:null,actual:null,commitment:ofId===1?'COMMITTED':'FORECAST',locked:false,readiness:'READY',blockers:[],
    earliestStart:null,due:null,priority:0,createdAt:now,version:'v1',
    estimate:estimateDuration({contextKey:id,routingSetupMinutes:20,routingUnitMinutes:1,quantity,good:0,scrap:0,rework:0,observations:[]}),...patch};
}
function fixture(){
  const identity={clientId:'customer',articleId:'article',pieceId:'pt',versionId:'version',technicalHash:'hash',ready:true};
  const evidence:RecoveryGroupingEvidence={
    producer:{...identity,id:1,number:'OF-PRODUCER',quantity:100,status:'PLANIFIE',operationIds:['cut','mill']},
    recovery:{...identity,id:2,number:'OF-RECOVERY',quantity:10,status:'BROUILLON',operationIds:['recut','remill']},
    requestStatus:'WAITING_PLANNER',groupingActive:true,recoveryAlreadyCovered:false,originalIdentityMatches:true,sameClientSources:true,
    deadlines:[{of_id:2,label:'Donor',before:at(18)},{of_id:3,label:'Other source',before:at(16)}],issues:[],
  };
  const snapshot:CentralSnapshot={apiVersion:2,revision:'1',generatedAt:now,stale:false,activation:'COMMIT',
    tasks:[task('cut',1,10),task('mill',1,20,{committed:{start:at(10),end:at(12)}}),task('recut',2,10),task('remill',2,20)],
    resources:[{id:'machine:1',kind:'MACHINE',label:'Takumi',timezone:'Europe/Paris',version:'1',capacityEnabled:true,
      availability:[{start:at(6),end:at(22)}]}],
    dependencies:[{predecessorId:'op:cut',successorId:'op:mill',releasedQuantity:0,transferQuantity:null,lagMinutes:0},
      {predecessorId:'op:recut',successorId:'op:remill',releasedQuantity:0,transferQuantity:null,lagMinutes:0}],
    sources:[],demands:[],allocations:[],coverageAvailable:true,total:4,nextCursor:null,
  };
  return {snapshot,evidence,now};
}
const evaluate=(edit?:(f:ReturnType<typeof fixture>)=>void)=>{const f=fixture();edit?.(f);return previewRecoveryConsolidation(f);};
const codes=(edit:(f:ReturnType<typeof fixture>)=>void)=>evaluate(edit).issues.map(i=>i.code);

describe('recovery grouping before cutting closes',()=>{
  it('adds productive time only and remaps the draft routing without mutating any state',()=>{
    const f=fixture(),before=structuredClone(f),result=previewRecoveryConsolidation(f);
    expect(result).toMatchObject({read_only:true,feasible:true,issues:[],proposed_quantity:110,additional_minutes:20});
    expect(result.proposed_finish).toBe('2026-10-12T12:20:00.000Z');
    expect(result.changes.map(c=>c.taskId)).toEqual(['op:cut','op:mill']);expect(f).toEqual(before);
  });
  it('preserves running start, actual progress and consumed setup',()=>{
    const f=fixture(),cut=f.snapshot.tasks[0];
    Object.assign(cut,{good:20,scrap:0,commitment:'STARTED',actual:{start:at(7)},committed:{start:at(7),end:at(10)}});
    cut.estimate=estimateDuration({contextKey:'cut',routingSetupMinutes:20,routingUnitMinutes:1,quantity:100,good:20,scrap:0,rework:0,setupCompletedMinutes:20,observations:[]});
    const before=structuredClone(f),result=previewRecoveryConsolidation(f);
    expect(result.feasible).toBe(true);expect(result.operations[0]).toMatchObject({before_minutes:80,after_minutes:90,good:20,scrap:0});
    expect(result.changes[0].after.start).toBe(at(7));expect(f).toEqual(before);
  });
  it.each(['scrap','rework'] as const)('shows unsecured %s before adding a recovery that approval would refuse',counter=>{
    expect(codes(f=>{f.snapshot.tasks[0][counter]=1;})).toContain('GROUPING_YIELD_UNSECURED');
  });
  it('uses the assigned machine estimate rather than the general routing average',()=>{
    const result=evaluate(f=>{const cut=f.snapshot.tasks[0];cut.resourceEstimates={'machine:1':{...cut.estimate!,unitMinutes:2,remainingMinutes:220}};});
    expect(result.additional_minutes).toBe(30);expect(result.operations[0].after_minutes).toBe(240);
  });
  it('rejects an invalid machine estimate without silently reusing its old duration',()=>{
    expect(codes(f=>{const cut=f.snapshot.tasks[0];cut.resourceEstimates={'machine:1':{...cut.estimate!,unitMinutes:NaN}};})).toContain('GROUPING_DURATION_MISSING');
  });
  it.each(['DONE','end'] as const)('refuses completed cutting (%s)',mode=>{
    expect(codes(f=>{if(mode==='DONE')f.snapshot.tasks[0].commitment='DONE';else f.snapshot.tasks[0].actual={end:at(7)};})).toContain('GROUPING_CUTTING_FINISHED');
  });
  it('protects other source deadlines, including equality',()=>{
    expect(codes(f=>{f.evidence.deadlines[1].before='2026-10-12T12:20:00.000Z';})).toContain('GROUPING_DELIVERY_TOO_LATE');
  });
  it.each(['pieceId','versionId','technicalHash','clientId'] as const)('refuses different %s',field=>{
    expect(codes(f=>{f.evidence.recovery[field]='different';})).toContain('GROUPING_DEFINITION_MISMATCH');
  });
  it('keeps another client commitment fixed, including a workstation alias',()=>{
    const f=fixture();f.snapshot.resources[0].capacityId='capacity:1';
    f.snapshot.resources.push({...f.snapshot.resources[0],id:'poste:1',kind:'POSTE'});
    f.snapshot.tasks.push(task('other',3,10,{clientId:'other',committed:{start:at(10),end:at(11)},commitment:'COMMITTED',resourceIds:['poste:1']}));
    const before=structuredClone(f),result=previewRecoveryConsolidation(f);
    expect(result.feasible).toBe(true);expect(Date.parse(result.changes[0].after.start)).toBeGreaterThanOrEqual(Date.parse(at(11)));
    expect(result.changes.every(c=>['op:cut','op:mill'].includes(c.taskId))).toBe(true);expect(f).toEqual(before);
  });
  it('never pauses running work to make room for another commitment',()=>{
    expect(codes(f=>{f.snapshot.tasks[0].actual={start:at(7)};f.snapshot.tasks[0].commitment='STARTED';
      f.snapshot.tasks.push(task('other',3,10,{committed:{start:at(9),end:at(10)},commitment:'COMMITTED'}));})).toContain('GROUPING_RUNNING_INTERRUPTION');
  });
  it('does not make an unrelated existing late dependency block this recovery',()=>{
    const result=evaluate(f=>{
      f.snapshot.tasks.push(task('other-a',3,10,{committed:{start:at(17),end:at(18)},commitment:'COMMITTED'}),
        task('other-b',4,20,{committed:{start:at(16),end:at(17)},commitment:'COMMITTED'}));
      f.snapshot.dependencies.push({predecessorId:'op:other-a',successorId:'op:other-b',releasedQuantity:0,transferQuantity:null,lagMinutes:0});
    });
    expect(result.feasible).toBe(true);expect(result.changes.every(c=>['op:cut','op:mill'].includes(c.taskId))).toBe(true);
  });
  it('honors maintenance closures',()=>{
    const result=evaluate(f=>{f.snapshot.resources[0].availability=[{start:at(6),end:at(9)},{start:at(12),end:at(22)}];});
    expect(result.feasible).toBe(true);expect(result.proposed_finish).toBe('2026-10-12T15:20:00.000Z');
  });
  it('requires a complete, unambiguous routing',()=>{
    expect(codes(f=>{f.snapshot.tasks[3].phase=10;})).toContain('GROUPING_ROUTING_MISMATCH');
    expect(codes(f=>{f.evidence.producer.operationIds.push('missing');})).toContain('GROUPING_OPERATIONS_MISSING');
  });
  it('surfaces unavailable prerequisites and dependent fixed commitments',()=>{
    expect(codes(f=>{f.snapshot.dependencies.push({predecessorId:'missing',successorId:'op:cut',transferQuantity:null,releasedQuantity:0,lagMinutes:0});})).toContain('GROUPING_DEPENDENCY_MISSING');
    expect(codes(f=>{f.snapshot.tasks.push(task('child',3,30,{committed:{start:at(12),end:at(13)},commitment:'COMMITTED'}));
      f.snapshot.dependencies.push({predecessorId:'op:mill',successorId:'op:child',transferQuantity:null,releasedQuantity:0,lagMinutes:0});})).toContain('LOCKED_DEPENDENCY');
  });
  it('keeps material and supplier decisions blocking',()=>{
    expect(codes(f=>{f.evidence.issues.push({code:'MATERIAL_LOT_LIMIT',message:'2 maximum'});})).toContain('MATERIAL_LOT_LIMIT');
    expect(codes(f=>{f.snapshot.tasks[1].external={packages:[],fullReadyAt:null,firstBatchReadyAt:null,issues:[]};})).toContain('GROUPING_EXTERNAL_CAPACITY');
  });
  it('rejects stale or truncated snapshots and missing promises',()=>{
    expect(codes(f=>{f.snapshot.nextCursor='next';})).toContain('GROUPING_SNAPSHOT_INCOMPLETE');
    expect(codes(f=>{f.evidence.deadlines[0].before=null;})).toContain('GROUPING_PROMISE_MISSING');
  });
  it('does not accept an already engaged or covered recovery',()=>{
    expect(codes(f=>{f.snapshot.tasks[2].committed={start:at(8),end:at(9)};})).toContain('RECOVERY_ENGAGED');
    expect(codes(f=>{f.evidence.recoveryAlreadyCovered=true;})).toContain('RECOVERY_ENGAGED');
  });
});
