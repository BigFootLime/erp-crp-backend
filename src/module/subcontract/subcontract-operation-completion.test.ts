import { describe, it, expect } from 'vitest';
import { completedSubcontractEvidence } from './subcontract-operation-completion';
import type { SubcontractFlow } from './subcontract-flow.types';

function flow(quantity:number,id:string):SubcontractFlow {
  return {packageId:id,operationId:'operation',ofId:95,supplierId:'supplier',supplierName:'Fixture',orderId:'order',
    orderCode:'TEST',orderLineId:id,unit:'U',planned:quantity,issued:quantity,returned:quantity,custody:0,
    released:quantity,transferred:quantity,promisedDate:null,promiseSource:'ESTIMATE',
    departedAt:'2026-10-12T10:00:00Z',lastReturnAt:'2026-10-13T05:00:00Z',status:'CLOSED',version:'1',
    returns:[{id:'origin-'+id,packageId:id,operationId:'operation',receiptLineId:'receipt-'+id,receiptNumber:'TEST',
      lotId:'lot-'+id,lotCode:'TEST-'+id,quantity,returnedAt:'2026-10-13T05:00:00Z',released:quantity,
      transferred:quantity,transferable:0,blockers:[]}]};
}
describe('canonical external completion proof',()=>{
  it('finishes the20 population across18+2 without merging origins',()=>{
    const proof=completedSubcontractEvidence(20,[flow(18,'a'),flow(2,'b')]);
    expect(proof).toMatchObject({quantity:20,unit:'U',packageIds:['a','b']});
    expect(proof?.returns.map(r=>r.quantity)).toEqual([18,2]);
  });
  it.each(['SENT','CANCELLED'])('does not finish a%s dossier',status=>{
    expect(completedSubcontractEvidence(20,[flow(18,'a'),{...flow(2,'b'),status}])).toBeNull();
  });
  it('does not turn a completed partial batch into an entire operation',()=>{
    expect(completedSubcontractEvidence(20,[flow(18,'a')])).toBeNull();
  });
  it.each(['issued','returned','released','transferred','custody'] as const)('checks%s independently',key=>{
    const b={...flow(2,'b'),[key]:key==='custody'?1:1};
    expect(completedSubcontractEvidence(20,[flow(18,'a'),b])).toBeNull();
  });
  it('does not infer a definitive loss from quality hold',()=>{
    const b=flow(2,'b');b.returns[0].released=1;b.released=1;
    expect(completedSubcontractEvidence(20,[flow(18,'a'),b])).toBeNull();
  });
  it('requires an actual receipt for every origin',()=>{
    const b=flow(2,'b');b.returns[0].receiptLineId=null;
    expect(completedSubcontractEvidence(20,[flow(18,'a'),b])).toBeNull();
  });
  it('preserves a newer quality blocker even on a historically closed dossier',()=>{
    const b=flow(2,'b');b.returns[0].blockers=['Quality hold'];
    expect(completedSubcontractEvidence(20,[flow(18,'a'),b])).toBeNull();
  });
  it.each(['MM','KG',''])('does not convert%s into piece counts',unit=>{
    expect(completedSubcontractEvidence(20,[flow(18,'a'),{...flow(2,'b'),unit}])).toBeNull();
  });
  it('refuses duplicate origins and excess transfers',()=>{
    const a=flow(10,'a');expect(completedSubcontractEvidence(20,[a,a])).toBeNull();
    a.returns[0].transferred=11;expect(completedSubcontractEvidence(10,[a])).toBeNull();
  });
  it.each([0,-1,NaN,Infinity])('rejects invalid target%s',target=>{
    expect(completedSubcontractEvidence(target,[flow(2,'b')])).toBeNull();
  });
});
