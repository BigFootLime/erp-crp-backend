import { HttpError } from '../../../utils/httpError';
import { consumeMaterialBar, type MaterialBar, type MaterialBarHold } from './material-bars';

export type PhysicalBarCut = { barId:string; expectedVersion:number; quantity:number;
  barClosure?:{ discardedQuantity:number; acknowledgedLargeRemainder:boolean } };
export type PhysicalBarDebitSource = { reservationId:string; batchId:string; quantity:number; bars:PhysicalBarCut[] };
export type PhysicalBarDebitChange = { bar:MaterialBar; remainingMm:number; nextVersion:number;
  sources:Array<{reservationId:string; cutMm:number; discardedMm:number; heldBeforeMm:number; heldAfterMm:number; extraMm:number}> };
const milli=(n:number)=>{
  if(!Number.isFinite(n)||n<0||n>1e9||Math.abs(n*1000-Math.round(n*1000))>1e-6)
    throw new HttpError(422,'MATERIAL_BAR_DEBIT_INVALID','Vérifiez les longueurs des barres, avec trois décimales maximum.');
  return Math.round(n*1000);
};
function conflict(message:string):never{throw new HttpError(409,'MATERIAL_BAR_DEBIT_CHANGED',message);}

/** Several accounting holds may fund a cut on one bar. Plan all sources before
 * changing stock so closure is independent of the reservation write order. */
export function planPhysicalBarDebit(input:{bars:MaterialBar[];holds:MaterialBarHold[];sources:PhysicalBarDebitSource[]}) {
  const sourceIds=new Set<string>(),changes=new Map<string,PhysicalBarDebitChange>(),closers=new Map<string,PhysicalBarCut>();
  for(const source of input.sources){
    if(sourceIds.has(source.reservationId))conflict('Une réservation figure deux fois dans le débit.');
    sourceIds.add(source.reservationId);
    if(!source.bars.length||source.bars.reduce((sum,b)=>sum+milli(b.quantity),0)!==milli(source.quantity))
      conflict('Le total coupé doit correspondre aux barres sélectionnées.');
    const seen=new Set<string>();
    for(const cut of source.bars){
      const bar=input.bars.find(b=>b.id===cut.barId);
      if(!bar||bar.batchId!==source.batchId||bar.version!==cut.expectedVersion||seen.has(cut.barId))
        conflict('Une barre a changé ou ne correspond pas à cette réservation.');
      seen.add(cut.barId);
      const held=milli(input.holds.find(h=>h.barId===bar.id&&h.reservationId===source.reservationId)?.remainingMm??0);
      const quantity=milli(cut.quantity),discarded=milli(cut.barClosure?.discardedQuantity??0);
      if(!quantity||quantity>held)conflict('La longueur coupée dépasse la réservation de cette barre.');
      if(cut.barClosure){if(closers.has(bar.id))conflict('Le solde de la barre ne doit être déclaré qu’une fois.');closers.set(bar.id,cut);}
      const change:PhysicalBarDebitChange=changes.get(bar.id)??{bar,remainingMm:bar.lengthMm,nextVersion:bar.version+1,sources:[]};
      change.sources.push({reservationId:source.reservationId,cutMm:quantity/1000,discardedMm:discarded/1000,
        heldBeforeMm:held/1000,heldAfterMm:Math.max(0,held-quantity-discarded)/1000,extraMm:Math.max(0,quantity+discarded-held)/1000});
      changes.set(bar.id,change);
    }
  }
  for(const change of changes.values()){
    const cutMm=change.sources.reduce((sum,s)=>sum+milli(s.cutMm),0)/1000;
    const discardedMm=change.sources.reduce((sum,s)=>sum+milli(s.discardedMm),0)/1000;
    const remainingHolds=input.holds.filter(h=>h.barId===change.bar.id).reduce((sum,h)=>sum+milli(
      change.sources.find(s=>s.reservationId===h.reservationId)?.heldAfterMm??h.remainingMm),0)/1000;
    Object.assign(change,consumeMaterialBar({bar:change.bar,expectedVersion:change.bar.version,cutMm,discardedMm,
      close:closers.has(change.bar.id),acknowledgedLargeRemainder:closers.get(change.bar.id)?.barClosure?.acknowledgedLargeRemainder??false,
      heldByOtherNeedsMm:remainingHolds}));
  }
  return [...changes.values()].sort((a,b)=>a.bar.id.localeCompare(b.bar.id));
}
