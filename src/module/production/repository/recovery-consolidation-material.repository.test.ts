import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks=vi.hoisted(()=>({material:vi.fn(),available:vi.fn(),policy:vi.fn()}));
vi.mock('./of-material.repository',()=>({readMaterialTx:mocks.material}));
vi.mock('./material-reservation-availability.repository',()=>({readMaterialReservationAvailabilityTx:mocks.available}));
vi.mock('./of-material-policy.repository',()=>({readMaterialOriginPolicyTx:mocks.policy}));
import { readRecoveryConsolidationMaterialTx } from './recovery-consolidation-material.repository';

const need=(ofId:number)=>({id:`need${ofId}`,key:'steel',articleId:'steel',unit:'mm',designation:'Acier',reviewed:true,
  required:ofId===1?11000:1100,consumed:ofId===1?2200:0,consumptionAdjustment:0,operationId:`cut${ofId}`,blockers:[],
  requirements:{grade:'42CD4',condition:'SOUS ETAT',ownerClientId:null,dimensions:{diameter:35},certificates:[],manualChecks:[]},
  debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:100,kerfPerBlank:10,yieldValidated:true},supplyMode:'PURCHASE'});
const material=(id:number)=>({ofId:id,quantity:id===1?100:10,previousNeeds:[],needs:[need(id)],operations:[{id:`cut${id}`,phase:10}],version:`v${id}`});
let producer:ReturnType<typeof material>,recovery:ReturnType<typeof material>;
const available=(quantity:number,blockers:string[]=[])=>new Map([['steel',{usable:quantity,reservations:new Map([['reservation',quantity]]),blockers}]]);
const tx={query:vi.fn()} as unknown as Pick<PoolClient,'query'>;
beforeEach(()=>{
  vi.clearAllMocks();producer=material(1);recovery=material(2);
  mocks.material.mockImplementation(async(_tx,id)=>id===1?producer:recovery);
  mocks.available.mockImplementation(async(_tx,m)=>available(m.ofId===1?8800:1100));
  mocks.policy.mockResolvedValue({critical:false,maximumLots:2,usedOrigins:['heat1','heat2'],originsByLot:{}});
});
describe('additional material for a running producer',()=>{
  it('counts consumed stock, actual reserved stock and kerf exactly once',async()=>{
    expect(await readRecoveryConsolidationMaterialTx(tx,1,2)).toMatchObject({ready:true,groups:[{required:12100,consumed:2200,producer_reserved:8800,recovery_reserved:1100,missing:0}]});
    expect(tx.query).not.toHaveBeenCalled();
  });
  it('preserves actual debit adjustments in the additional requirement',async()=>{
    producer.needs[0].consumptionAdjustment=50;
    const result=await readRecoveryConsolidationMaterialTx(tx,1,2);
    expect(result.groups[0].missing).toBe(50);expect(result.ready).toBe(false);
  });
  it.each([[false,2,['a','b','c']],[true,1,['a','b']]] as const)('rejects excessive committed origins (critical %s)',async(critical,maximumLots,usedOrigins)=>{
    mocks.policy.mockResolvedValue({critical,maximumLots,usedOrigins,originsByLot:{}});
    expect((await readRecoveryConsolidationMaterialTx(tx,1,2)).issues.map(i=>i.code)).toContain('MATERIAL_LOT_LIMIT');
  });
  it('does not count a purchase or quarantined reservation as usable stock',async()=>{
    mocks.available.mockImplementation(async(_tx,m)=>m.ofId===1?available(8800):available(0,['Lot en quarantaine']));
    const result=await readRecoveryConsolidationMaterialTx(tx,1,2);
    expect(result.groups[0].missing).toBe(1100);expect(result.issues.map(i=>i.code)).toContain('GROUPING_MATERIAL_BLOCKED');
  });
  it('does not let excess producer stock mask an unreserved recovery',async()=>{
    mocks.available.mockImplementation(async(_tx,m)=>available(m.ofId===1?9900:0));
    const result=await readRecoveryConsolidationMaterialTx(tx,1,2);
    expect(result.groups[0].missing).toBe(0);expect(result.issues.map(i=>i.code)).toContain('RECOVERY_MATERIAL_MISSING');
  });
  it('rejects mismatched specifications, phases and consumed recovery stock',async()=>{
    recovery.needs[0].requirements.grade='ALUMINIUM';
    expect((await readRecoveryConsolidationMaterialTx(tx,1,2)).issues.map(i=>i.code)).toContain('GROUPING_MATERIAL_DEFINITION');
    recovery=material(2);recovery.operations[0].phase=20;
    expect((await readRecoveryConsolidationMaterialTx(tx,1,2)).ready).toBe(false);
    recovery=material(2);recovery.needs[0].consumed=10;
    expect((await readRecoveryConsolidationMaterialTx(tx,1,2)).issues.map(i=>i.code)).toContain('RECOVERY_MATERIAL_CONSUMED');
  });
  it('supports assembly without direct material',async()=>{
    producer.needs=[];recovery.needs=[];
    expect(await readRecoveryConsolidationMaterialTx(tx,1,2)).toMatchObject({ready:true,groups:[]});
  });
});
