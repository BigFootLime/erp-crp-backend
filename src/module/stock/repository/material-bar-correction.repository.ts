import type {PoolClient} from 'pg';
import {z} from 'zod';
import {HttpError} from '../../../utils/httpError';
import {lockMaterialBarInventoryTx} from './material-bar-inventory.repository';
import {refreshMaterialBarBatchesTx} from './material-bar-debit.repository';

type Db=Pick<PoolClient,'query'>;
const length=z.number().finite().nonnegative().max(1e9);
const shape=z.object({version:z.number().int().positive(),remainingMm:length});
const proofSchema=z.object({id:z.string().uuid(),barId:z.string().uuid(),batchId:z.string().uuid(),before:shape,
  after:shape.extend({sources:z.array(z.object({reservationId:z.string().uuid(),stockMovementId:z.string().uuid(),
    cutMm:length,discardedMm:length,heldBeforeMm:length,heldAfterMm:length,extraMm:length})).min(1)})});
type CutProof=z.infer<typeof proofSchema>;
type Original={reservationId:string;movementId:string;quantity:number;extended:number};
function conflict():never{throw new HttpError(409,'MATERIAL_BAR_CORRECTION_CHANGED',
  'La barre ou ses réservations ont changé après ce débit. Le stock doit vérifier la correction avant de restaurer sa longueur.');}

/** Prove the original geometry is still the latest one before any inverse IN.
 * Never restore a bar already used, moved, remeasured or reserved afterward. */
export async function prepareMaterialBarCorrectionTx(tx:Db,commandKey:string,originals:Original[]){
  if(!(await tx.query<{installed:boolean}>("SELECT to_regclass('public.stock_material_bar_events') IS NOT NULL AS installed")).rows[0]?.installed)return [];
  const rows=(await tx.query(`SELECT e.id::text,e.bar_id::text AS "barId",b.stock_batch_id::text AS "batchId",
    e.before_state AS before,e.after_state AS after FROM public.stock_material_bar_events e
    JOIN public.stock_material_bars b ON b.id=e.bar_id WHERE e.command_key=$1::uuid AND e.action='CUT' ORDER BY e.bar_id`,[commandKey])).rows;
  const proofs:CutProof[]=rows.map(row=>{const parsed=proofSchema.safeParse(row);if(!parsed.success)return conflict();return parsed.data;});
  if(!proofs.length)return [];
  const inventories=new Map<string,Awaited<ReturnType<typeof lockMaterialBarInventoryTx>>>();
  for(const batchId of [...new Set(proofs.map(p=>p.batchId))].sort()){
    const inventory=await lockMaterialBarInventoryTx(tx,batchId);
    if(inventory.status!=='CONFIRMED')conflict();inventories.set(batchId,inventory);
  }
  const totals=new Map<string,{quantity:number;extended:number}>();
  for(const proof of proofs){
    const inventory=inventories.get(proof.batchId)!,bar=inventory.bars.find((b:{id:string})=>b.id===proof.barId);
    if(!bar||bar.version!==proof.after.version||bar.lengthMm!==proof.after.remainingMm||proof.after.version!==proof.before.version+1)conflict();
    for(const source of proof.after.sources){
      if(!originals.some(o=>o.reservationId===source.reservationId&&o.movementId===source.stockMovementId))conflict();
      const held=inventory.holds.find((h:{barId:string;reservationId:string})=>h.barId===proof.barId&&h.reservationId===source.reservationId)?.remainingMm??0;
      if(held!==source.heldAfterMm)conflict();
      const sum=totals.get(source.reservationId)??{quantity:0,extended:0};
      sum.quantity+=Math.round((source.cutMm+source.discardedMm)*1000);sum.extended+=Math.round(source.extraMm*1000);totals.set(source.reservationId,sum);
    }
  }
  for(const [id,total] of totals){const original=originals.find(o=>o.reservationId===id)!;
    if(total.quantity!==Math.round(original.quantity*1000)||total.extended!==Math.round(original.extended*1000))conflict();}
  return proofs;
}

export async function applyMaterialBarCorrectionTx(tx:Db,proofs:CutProof[],input:{commandKey:string;actor:number;reason:string;
  inverses:Array<{reservationId:string;movementId:string}>}){
  for(const proof of proofs){
    const updated=await tx.query(`UPDATE public.stock_material_bars SET remaining_length_mm=$3,row_version=row_version+1,updated_at=now(),updated_by=$4
      WHERE id=$1::uuid AND row_version=$2 AND retired_at IS NULL RETURNING id`,[proof.barId,proof.after.version,proof.before.remainingMm,input.actor]);
    if(!updated.rows.length)conflict();
    const sources=[];
    for(const source of proof.after.sources){
      const inverse=input.inverses.find(i=>i.reservationId===source.reservationId);if(!inverse)conflict();
      const restored=await tx.query(`UPDATE public.stock_material_bar_reservations SET remaining_length_mm=$3,updated_at=now(),updated_by=$4
        WHERE bar_id=$1::uuid AND reservation_id=$2::uuid AND remaining_length_mm=$5 RETURNING bar_id`,
      [proof.barId,source.reservationId,source.heldBeforeMm,input.actor,source.heldAfterMm]);
      if(!restored.rows.length)conflict();
      sources.push({...source,stockMovementId:inverse.movementId,compensatesMovementId:source.stockMovementId});
    }
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'COMPENSATE',$3::uuid,$4::jsonb,$5::jsonb,$6,$7)`,[proof.barId,input.commandKey,sources[0].stockMovementId,
      JSON.stringify({version:proof.after.version,remainingMm:proof.after.remainingMm}),
      JSON.stringify({version:proof.after.version+1,remainingMm:proof.before.remainingMm,compensatesEventId:proof.id,sources}),input.reason,input.actor]);
  }
  await refreshMaterialBarBatchesTx(tx,proofs.map(p=>p.batchId));
}
