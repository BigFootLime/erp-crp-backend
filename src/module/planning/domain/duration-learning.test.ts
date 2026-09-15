import {describe,it,expect} from 'vitest';
import {buildDurationObservation,unionMinutes,durationContextKey,type LearningSource,type LearningSegment} from './duration-learning';
import {estimateDuration} from './central-estimation';
const context={pieceId:'p',revision:'A',phase:10,machineId:'m',configuration:''};
const segment=(patch:Partial<LearningSegment>={}):LearningSegment=>({id:'p1',start:'2026-09-01T08:00:00Z',end:'2026-09-01T09:00:00Z',
  status:'DONE',validated:true,rejected:false,context,bucket:'PRODUCTION',replaced:false,updatedAt:'2026-09-01T10:00:00Z',...patch});
const source=(patch:Partial<LearningSource>={}):LearningSource=>({operationId:'op',status:'DONE',cancelled:false,
  completedAt:'2026-09-01T09:00:00Z',context,legacyUnmapped:false,segments:[segment()],
  quantities:[{id:'q1',pointageId:'p1',good:8,scrap:2,rework:0,pending:0,declaredAt:'2026-09-01T09:00:00Z'}],...patch});
describe('observations from manufacturing measurements',()=>{
  it('groups a manufacturing run, separates setup and does not multiply overlapping operator time',()=>{
    const observed=buildDurationObservation(source({segments:[segment(),segment({id:'p2'}),
      segment({id:'setup',bucket:'SETUP',start:'2026-09-01T07:30:00Z',end:'2026-09-01T08:00:00Z'}),
      segment({id:'break',bucket:'EXCLUDED',start:'2026-09-01T09:00:00Z',end:'2026-09-01T10:00:00Z'})]}));
    expect(observed).toMatchObject({productiveMinutes:60,setupMinutes:30,quantity:10,validated:true,excludedReason:null});
    expect(unionMinutes([segment(),segment({start:'2026-09-01T09:00:00Z',end:'2026-09-01T10:00:00Z'})])).toBe(120);
  });
  it('keeps unknown setup null',()=>expect(buildDurationObservation(source()).setupMinutes).toBeNull());
  it.each([
    ['NOT_VALIDATED',source({segments:[segment({validated:false})]})],
    ['CANCELLED',source({cancelled:true})],
    ['OPERATION_NOT_COMPLETE',source({status:'RUNNING'})],
    ['LEGACY_MIXED_MEASUREMENT',source({legacyUnmapped:true})],
    ['CONTEXT_MISSING',source({segments:[segment({context:null})]})],
    ['MULTIPLE_CONTEXTS',source({segments:[segment(),segment({id:'p2',context:{...context,machineId:'other'}})]})],
    ['AMBIGUOUS_QUANTITY',source({quantities:[{...source().quantities[0],pending:1}]})],
    ['INVALID_INTERVAL',source({segments:[segment({end:'2026-09-01T07:00:00Z'})]})],
    ['OVERLAPPING_ACTIVITIES',source({segments:[segment(),segment({id:'setup',bucket:'SETUP'})]})],
  ])('excludes %s',(reason,input)=>expect(buildDurationObservation(input).excludedReason).toBe(reason));
  it('removes a replaced segment immediately and waits for validation of its replacement',()=>{
    const input=source({segments:[segment({replaced:true,status:'CORRECTED'}),segment({id:'replacement',correctsId:'p1',validated:false,end:'2026-09-01T08:30:00Z'})]});
    expect(buildDurationObservation(input)).toMatchObject({productiveMinutes:30,validated:false,excludedReason:'NOT_VALIDATED'});
    input.segments[1].validated=true;
    expect(buildDurationObservation(input)).toMatchObject({productiveMinutes:30,validated:true});
  });
  it('applies signed quantity compensations and is insensitive to input order',()=>{
    const first=source().quantities[0];
    const input=source({quantities:[first,{...first,id:'comp',good:-8,scrap:-2},{...first,id:'correct',good:4,scrap:1}]});
    expect(buildDurationObservation(input).quantity).toBe(5);
    expect(buildDurationObservation({...input,quantities:[...input.quantities].reverse()}).sourceRevision).toBe(buildDurationObservation(input).sourceRevision);
  });
  it('excludes quantities attached to cancelled production even if another segment remains',()=>{
    const input=source({segments:[segment({status:'CANCELLED'}),segment({id:'p2'})]});
    expect(buildDurationObservation(input).excludedReason).toBe('QUANTITY_WITHOUT_PRODUCTIVE_SEGMENT');
  });
  it('follows explicit correction chains without treating session predecessors as corrections',()=>{
    const input=source({status:'RUNNING',segments:[segment({status:'CORRECTED',replaced:true}),
      segment({id:'p2',correctsId:'p1',status:'CORRECTED',replaced:true}),segment({id:'p3',correctsId:'p2'})]});
    expect(buildDurationObservation(input).current).toEqual({productiveMinutes:60,attributableQuantity:10});
    input.segments[2].correctsId=null;
    expect(buildDurationObservation(input).current).toBeNull();
  });
  it('adjusts the current run only with closed attributed segments',()=>{
    expect(buildDurationObservation(source({status:'RUNNING'})).current).toEqual({productiveMinutes:60,attributableQuantity:10});
    expect(buildDurationObservation(source({status:'RUNNING',segments:[segment({end:null,status:'RUNNING'})]})).current).toBeNull();
    expect(buildDurationObservation(source({status:'RUNNING',quantities:[{...source().quantities[0],pointageId:null}]})).current).toBeNull();
  });
  it('isolates revision, machine, configuration and phase',()=>{
    const key=durationContextKey(context);
    for(const patch of [{revision:'B'},{machineId:'other'},{configuration:'special'},{phase:20}])expect(durationContextKey({...context,...patch})).not.toBe(key);
  });
  it('weights setup using only measured setups, not all productive observations',()=>{
    const estimate=estimateDuration({contextKey:'c',routingSetupMinutes:60,routingUnitMinutes:10,quantity:10,good:0,scrap:0,rework:0,
      observations:Array.from({length:20},(_,i)=>({id:String(i),contextKey:'c',validated:true,recordedAt:String(i),productiveMinutes:50,
        quantity:10,setupMinutes:i===0?30:null}))});
    expect(estimate.setupObservations).toBe(1);expect(estimate.setupMinutes).toBe(55);expect(estimate.unitMinutes).toBe(6);
  });
});
