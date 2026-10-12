import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { planPhysicalBarDebit, type PhysicalBarDebitSource } from '../domain/material-bar-debit';
import { lockMaterialBarInventoryTx, readMaterialBarInventoryTx } from './material-bar-inventory.repository';

type Db=Pick<PoolClient,'query'>;
export type MaterialBarConsumption={reservationId:string;quantityMm:number;extraMm:number;barIds:string[]};
const authorizedConsumptions=new WeakSet<MaterialBarConsumption>();
export function materialBarConsumptionExtra(value:MaterialBarConsumption,reservationId:string,quantity:number){
  if(!authorizedConsumptions.has(value)||value.reservationId!==reservationId||Math.round(value.quantityMm*1000)!==Math.round(quantity*1000))
    throw new HttpError(409,'MATERIAL_BAR_DEBIT_REQUIRED','Sélectionnez les barres dans le parcours de découpe.');
  return value.extraMm;
}

/** Planning/OF and all source lots are already locked by the production owner.
 * All canonical debits and applyMaterialBarDebitTx must share this transaction. */
export async function prepareMaterialBarDebitTx(tx:Db,sources:PhysicalBarDebitSource[]){
  const inventories=[];
  for(const batchId of [...new Set(sources.map(s=>s.batchId))].sort()){
    const inventory=await lockMaterialBarInventoryTx(tx,batchId);
    if(inventory.status!=='CONFIRMED')throw new HttpError(409,'MATERIAL_BAR_REVIEW_REQUIRED',inventory.warning??'Vérifiez les barres avant le débit.');
    inventories.push(inventory);
  }
  const changes=planPhysicalBarDebit({bars:inventories.flatMap(i=>i.bars),holds:inventories.flatMap(i=>i.holds),sources});
  const consumptions=new Map<string,MaterialBarConsumption>();
  for(const source of sources){
    const allocations=changes.flatMap(change=>change.sources.filter(s=>s.reservationId===source.reservationId));
    const value={reservationId:source.reservationId,barIds:source.bars.map(b=>b.barId),
      quantityMm:allocations.reduce((sum,s)=>sum+Math.round((s.cutMm+s.discardedMm)*1000),0)/1000,
      extraMm:allocations.reduce((sum,s)=>sum+Math.round(s.extraMm*1000),0)/1000};
    authorizedConsumptions.add(value);consumptions.set(source.reservationId,value);
  }
  return {changes,consumptions,batchIds:inventories.map(i=>i.batch.id)};
}
export type MaterialBarDebitPlan=Awaited<ReturnType<typeof prepareMaterialBarDebitTx>>;

export async function refreshMaterialBarBatchesTx(tx:Db,batchIds:readonly string[]){
  for(const batchId of new Set(batchIds)){
    await tx.query(`UPDATE public.stock_material_bar_inventories SET row_version=row_version+1,
      movement_count=(SELECT count(*) FROM public.stock_movements m WHERE m.stock_batch_id=$1::uuid AND m.status='POSTED')
      WHERE stock_batch_id=$1::uuid`,[batchId]);
    const inventory=await readMaterialBarInventoryTx(tx,batchId);
    if(inventory.status!=='CONFIRMED')throw new HttpError(409,'MATERIAL_BAR_DEBIT_INCOMPLETE',inventory.warning??'Le stock et les barres doivent correspondre après le débit.');
  }
}

/** Geometry follows the actual posted movements, before the WIP declaration.
 * A failure here or later rolls back stock, holds, events and production together. */
export async function applyMaterialBarDebitTx(tx:Db,plan:MaterialBarDebitPlan,input:{commandKey:string;actor:number;reason:string;
  consumed:Array<{reservationId:string;stockMovementId:string;quantity:number}>}){
  const movements=new Map(input.consumed.map(s=>[s.reservationId,s]));
  for(const [reservationId,authorization] of plan.consumptions){
    const movement=movements.get(reservationId);
    if(!movement||Math.round(movement.quantity*1000)!==Math.round(authorization.quantityMm*1000))
      throw new HttpError(409,'MATERIAL_BAR_DEBIT_INCOMPLETE','Une sortie matière ne correspond pas aux barres coupées.');
  }
  for(const change of plan.changes){
    const updated=await tx.query(`UPDATE public.stock_material_bars SET remaining_length_mm=$3,row_version=row_version+1,updated_at=now(),updated_by=$4
      WHERE id=$1::uuid AND row_version=$2 AND retired_at IS NULL RETURNING id`,[change.bar.id,change.bar.version,change.remainingMm,input.actor]);
    if(!updated.rows.length)throw new HttpError(409,'MATERIAL_BAR_DEBIT_CHANGED','Une barre a changé pendant le débit. Aucune sortie n’est conservée.');
    for(const source of change.sources){
      const held=await tx.query(`UPDATE public.stock_material_bar_reservations SET remaining_length_mm=$3,updated_at=now(),updated_by=$4
        WHERE bar_id=$1::uuid AND reservation_id=$2::uuid AND remaining_length_mm=$5 RETURNING bar_id`,
      [change.bar.id,source.reservationId,source.heldAfterMm,input.actor,source.heldBeforeMm]);
      if(!held.rows.length)throw new HttpError(409,'MATERIAL_BAR_DEBIT_CHANGED','Une affectation a changé pendant le débit. Aucune sortie n’est conservée.');
    }
    const sources=change.sources.map(s=>({...s,stockMovementId:movements.get(s.reservationId)!.stockMovementId}));
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'CUT',$3::uuid,$4::jsonb,$5::jsonb,$6,$7)`,[change.bar.id,input.commandKey,sources[0].stockMovementId,
      JSON.stringify({version:change.bar.version,remainingMm:change.bar.lengthMm}),
      JSON.stringify({version:change.nextVersion,remainingMm:change.remainingMm,sources}),input.reason,input.actor]);
  }
  await refreshMaterialBarBatchesTx(tx,plan.batchIds);
}
