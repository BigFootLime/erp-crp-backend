import { describe, expect, it } from 'vitest';
import { planMaterialBarCompensation } from './material-bar-compensation';
import type { MaterialBarMovementStock } from './material-bar-movement';

const bar = { id:'bar',batchId:'batch',lengthMm:2000,version:2 };
function fixture() {
  const source: MaterialBarMovementStock = { version:'v',status:'CONFIRMED',
    batch:{id:'batch',articleId:'article',lotId:'lot',physicalMm:2000,reservedMm:0},bars:[bar],holds:[],reservations:[] };
  return {original:{type:'OUT',batchId:'batch',quantity:1000},source,
    proofs:[{barId:'bar',action:'CUT',before:{...bar,lengthMm:3000,version:1},after:{...bar,source:'STOCK_MOVEMENT'}}]};
}
function inbound() {
  const f=fixture();f.original={type:'IN',batchId:'batch',quantity:2000};
  f.source.bars=[{...bar,version:1}];
  return {...f,proofs:[{barId:'bar',action:'INITIALIZE',before:null,after:{...bar,version:1,source:'STOCK_MOVEMENT'}}]};
}
describe('physical compensation from immutable history',()=>{
  it('restores the original cut bar, preserving its identity and advancing its version',()=>{
    const plan=planMaterialBarCompensation(fixture());expect(plan.kind).toBe('RESTORE');
    expect(plan.changes).toEqual([{bar,restoredMm:3000,nextVersion:3}]);
  });
  it('allows restoring free length while the unchanged remainder is reserved',()=>{
    const f=fixture();f.source.batch.reservedMm=1500;f.source.holds=[{barId:'bar',reservationId:'r',remainingMm:1500}];
    f.source.reservations=[{id:'r',batchId:'batch',remainingMm:1500}];expect(planMaterialBarCompensation(f).quantityMm).toBe(1000);
  });
  it.each(['ADJUST','ADJUSTMENT'])('restores a negative %s using the same physical proof',type=>{
    const f=fixture();f.original={...f.original,type,quantity:-1000};expect(planMaterialBarCompensation(f).kind).toBe('RESTORE');
  });
  it('retires exactly the unused incoming bar',()=>{
    expect(planMaterialBarCompensation(inbound())).toMatchObject({kind:'RETIRE',quantityMm:2000,changes:[{bar:{id:'bar'},restoredMm:0,nextVersion:2}]});
  });
  it('rejects removing a reserved incoming bar',()=>{
    const f=inbound();f.source.batch.reservedMm=100;f.source.holds=[{barId:'bar',reservationId:'r',remainingMm:100}];
    f.source.reservations=[{id:'r',batchId:'batch',remainingMm:100}];expect(()=>planMaterialBarCompensation(f)).toThrow(/réservée/);
  });
  it('returns the same transferred bar to its original batch',()=>{
    const f=fixture();f.original={type:'TRANSFER',batchId:'old',quantity:2000};
    f.proofs=[{barId:'bar',action:'MOVE',before:{...bar,batchId:'old',version:1},after:{...bar,source:'STOCK_MOVEMENT'}}];
    expect(planMaterialBarCompensation({...f,destinationBatchId:'old'})).toMatchObject({kind:'TRANSFER',quantityMm:2000});
    expect(()=>planMaterialBarCompensation({...f,destinationBatchId:'wrong'})).toThrow(/emplacements/);
  });
  it.each(['later cut','same-length reconciliation','missing bar'])('rejects %s after the original event',reason=>{
    const f=fixture();f.source.bars=reason==='missing bar'?[]:[{...bar,version:3,lengthMm:reason==='later cut'?1800:2000}];
    f.source.batch.physicalMm=f.source.bars[0]?.lengthMm??0;
    expect(()=>planMaterialBarCompensation(f)).toThrow(/utilisée/);
  });
  it.each(['empty','duplicate','wrong quantity','wrong direction','bad source','bad version','mixed action','bad precision'])('rejects %s proof',reason=>{
    const f=fixture();
    if(reason==='empty')f.proofs=[];
    if(reason==='duplicate')f.proofs.push(f.proofs[0]);
    if(reason==='wrong quantity')f.original.quantity=999;
    if(reason==='wrong direction')f.original.type='IN';
    if(reason==='bad source')f.proofs[0].after.source='RECEIPT';
    if(reason==='bad version')f.proofs[0].before.version=3;
    if(reason==='mixed action')f.proofs[0].action='MOVE';
    if(reason==='bad precision')f.proofs[0].before.lengthMm=3000.0001;
    expect(()=>planMaterialBarCompensation(f)).toThrow();
  });
  it('handles fractional millimetres without floating-point stock drift',()=>{
    const f=fixture();f.source.bars=[{...bar,lengthMm:0.1}];f.source.batch.physicalMm=0.1;f.original.quantity=0.2;
    f.proofs[0].before.lengthMm=0.3;f.proofs[0].after.lengthMm=0.1;
    expect(planMaterialBarCompensation(f).quantityMm).toBe(0.2);
  });
  it('rejects unconfirmed stock and quality allocation movements',()=>{
    const f=fixture();f.source.status='REVIEW_REQUIRED';expect(()=>planMaterialBarCompensation(f)).toThrow(/Confirmez/);
    f.source.status='CONFIRMED';f.original.type='DEPRECIATE';expect(()=>planMaterialBarCompensation(f)).toThrow(/prise en charge/);
  });
});
