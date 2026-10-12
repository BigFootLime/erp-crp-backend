import {describe,expect,it} from 'vitest';
import {planPhysicalBarDebit,type PhysicalBarDebitSource} from './material-bar-debit';
const bars=[{id:'a',batchId:'batch',lengthMm:1000,version:1},{id:'b',batchId:'batch',lengthMm:500,version:2}];
const holds=[{barId:'a',reservationId:'r1',remainingMm:210},{barId:'a',reservationId:'r2',remainingMm:11},
  {barId:'b',reservationId:'other',remainingMm:300}];
const source=(reservationId='r1',barId='a',quantity=210):PhysicalBarDebitSource=>({reservationId,batchId:'batch',quantity,bars:[{barId,quantity,expectedVersion:1}]});
const plan=(sources=[source()])=>planPhysicalBarDebit({bars,holds,sources});
describe('physical bar debit',()=>{
  it('combines two accounting sources on one bar and preserves all other holds',()=>{
    const changes=plan([source(),source('r2','a',11)]);
    expect(changes).toHaveLength(1);expect(changes[0]).toMatchObject({remainingMm:779,nextVersion:2});
    expect(changes[0].sources.map(s=>s.heldAfterMm)).toEqual([0,0]);
    expect(holds[2].remainingMm).toBe(300);
  });
  it('does not let an aggregate reservation borrow its cut length from another bar',()=>{
    expect(()=>plan([source('r1','a',211)])).toThrow(/réservation de cette barre/);
    expect(()=>plan([source('r1','b',110.5)])).toThrow(/changé/);
  });
  it('treats a free discarded remainder as an extension, without releasing a hold on another bar',()=>{
    const changes=planPhysicalBarDebit({bars:[{...bars[0],lengthMm:500},bars[1]],
      holds:[{barId:'a',reservationId:'r',remainingMm:100},{barId:'b',reservationId:'r',remainingMm:100}],
      sources:[{reservationId:'r',batchId:'batch',quantity:100,bars:[{barId:'a',quantity:100,expectedVersion:1,
        barClosure:{discardedQuantity:400,acknowledgedLargeRemainder:true}}]}]});
    expect(changes[0]).toMatchObject({remainingMm:0,sources:[{cutMm:100,discardedMm:400,extraMm:400,heldBeforeMm:100,heldAfterMm:0}]});
  });
  it('closes a shared bar independently of reservation input order',()=>{
    const first=source(),last=source('r2','a',11);last.bars[0].barClosure={discardedQuantity:779,acknowledgedLargeRemainder:true};
    for(const sources of [[first,last],[last,first]])expect(plan(sources)[0].remainingMm).toBe(0);
  });
  it('keeps the 150 mm warning confirmable',()=>{
    const s=source();s.bars[0].barClosure={discardedQuantity:790,acknowledgedLargeRemainder:false};
    expect(()=>plan([s])).toThrow(/réservation|besoin/); // r2 still owns 11 mm
    const withoutOther={bars,holds:holds.filter(h=>h.reservationId!=='r2'),sources:[s]};
    expect(()=>planPhysicalBarDebit(withoutOther)).toThrow(/150 mm/);
    s.bars[0].barClosure.acknowledgedLargeRemainder=true;
    expect(planPhysicalBarDebit(withoutOther)[0].remainingMm).toBe(0);
  });
  it.each([
    ()=>({...source(),batchId:'foreign'}),
    ()=>({...source(),quantity:200}),
    ()=>({...source(),bars:[{...source().bars[0],expectedVersion:7}]}),
    ()=>({...source(),quantity:420,bars:[source().bars[0],source().bars[0]]}),
  ])('rejects stale, duplicate or inconsistent source input before stock changes',make=>{
    expect(()=>plan([make()])).toThrow();
  });
  it('refuses a false closure that omits part of the remaining bar',()=>{
    const s=source();s.bars[0].barClosure={discardedQuantity:1,acknowledgedLargeRemainder:true};
    expect(()=>plan([s])).toThrow(/toute la longueur/);
  });
  it('supports several bars funded by the same reservation',()=>{
    const changes=planPhysicalBarDebit({bars,holds:[{barId:'a',reservationId:'r',remainingMm:221},{barId:'b',reservationId:'r',remainingMm:110.5}],
      sources:[{reservationId:'r',batchId:'batch',quantity:331.5,bars:[{barId:'a',expectedVersion:1,quantity:221},{barId:'b',expectedVersion:2,quantity:110.5}]}]});
    expect(changes.map(c=>c.remainingMm)).toEqual([779,389.5]);
  });
});
