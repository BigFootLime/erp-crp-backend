import {describe,expect,it} from 'vitest';
import {materialSourceYields} from './material-source-yield';
import {materialDebitSchema} from '../validators/of-material.validators';
const rule={form:'BAR' as const,stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true};
describe('per-bar observed yield',()=>{
  it('combines two holds on the same bar without requiring a fictitious yield on the top-up hold',()=>{
    expect(materialSourceYields({rule,good:2,scrap:0,sources:[
      {id:'r1',quantity:210,yield:{good:2,scrap:0},bars:[{barId:'bar',quantity:210}]},
      {id:'r2',quantity:11,yield:{good:0,scrap:0},bars:[{barId:'bar',quantity:11}]},
    ]})).toEqual([{id:'r1',good:2,scrap:0},{id:'r2',good:0,scrap:0}]);
  });
  it('does not join those same two holds if they actually belong to separate bars',()=>{
    expect(()=>materialSourceYields({rule,good:2,scrap:0,sources:[
      {id:'r1',quantity:210,yield:{good:2,scrap:0},bars:[{barId:'bar1',quantity:210}]},
      {id:'r2',quantity:11,yield:{good:0,scrap:0},bars:[{barId:'bar2',quantity:11}]},
    ]})).toThrow(/rendement/);
  });
  it('records several physical yields against one canonical reservation',()=>{
    expect(materialSourceYields({rule,good:2,scrap:1,sources:[{id:'r',quantity:331.5,
      bars:[{barId:'a',quantity:221,yield:{good:1,scrap:1}},{barId:'b',quantity:110.5,yield:{good:1,scrap:0}}]}]}))
      .toEqual([{id:'r',good:2,scrap:1}]);
  });
  it('requires the yield per bar when one reservation spans several bars',()=>{
    expect(()=>materialSourceYields({rule,good:3,scrap:0,sources:[{id:'r',quantity:331.5,yield:{good:3,scrap:0},
      bars:[{barId:'a',quantity:221},{barId:'b',quantity:110.5}]}]})).toThrow(/chaque lot/);
  });
  it('rejects mismatched per-reservation totals instead of reallocating scrap silently',()=>{
    expect(()=>materialSourceYields({rule,good:2,scrap:1,sources:[{id:'r',quantity:331.5,yield:{good:3,scrap:0},
      bars:[{barId:'a',quantity:221,yield:{good:1,scrap:1}},{barId:'b',quantity:110.5,yield:{good:1,scrap:0}}]}]})).toThrow(/total/);
  });
});
const uuid=(i:number)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const payload=()=>({expectedVersion:'a'.repeat(64),idempotencyKey:uuid(1),operationId:uuid(2),good:2,scrap:0,scrapReason:null,
  note:'Découpe saisie au poste',successorOperationId:null,remnants:[],sources:[{reservationId:uuid(3),expectedVersion:1,quantity:221,
    bars:[{barId:uuid(4),expectedVersion:2,quantity:221}]}]});
describe('physical debit request contract',()=>{
  it('accepts an identified physical bar, preserving the optimistic version',()=>{
    expect(materialDebitSchema.parse(payload()).sources[0].bars![0].expectedVersion).toBe(2);
  });
  it('still accepts existing unit and sheet requests without bar fields',()=>{
    const body=payload();delete (body.sources[0] as {bars?:unknown}).bars;expect(materialDebitSchema.safeParse(body).success).toBe(true);
  });
  it.each([
    (body:ReturnType<typeof payload>)=>{body.sources[0].quantity=220;},
    (body:ReturnType<typeof payload>)=>{body.sources[0].bars[0].quantity=220.1234;},
    (body:ReturnType<typeof payload>)=>{body.sources[0].bars[0].expectedVersion=0;},
    (body:ReturnType<typeof payload>)=>{body.sources[0].bars[0].barId='free text';},
    (body:ReturnType<typeof payload>)=>{body.sources[0].quantity=442;body.sources[0].bars.push({...body.sources[0].bars[0]});},
    (body:ReturnType<typeof payload>)=>{Object.assign(body.sources[0],{barClosure:{discardedQuantity:0,acknowledgedLargeRemainder:false}});},
    (body:ReturnType<typeof payload>)=>{Object.assign(body,{remnants:[{reservationId:uuid(3),quantity:100,dimensions:{longueur_mm:100}}]});},
  ])('rejects ambiguous, imprecise or double-counted physical input',mutate=>{
    const body=payload();mutate(body);expect(materialDebitSchema.safeParse(body).success).toBe(false);
  });
});
