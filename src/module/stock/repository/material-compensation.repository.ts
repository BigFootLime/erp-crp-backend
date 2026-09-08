import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {repoGetMovement,repoCreateMovement,repoPostMovement,lockStockStates,stockTargetKey,type AuditContext} from './stock.repository';

/** Internal, full reversal of one original material entry. All effects belong
 * to the production correction transaction, including restored reservations. */
export async function compensateMaterialMovementTx(tx:PoolClient,input:{movementId:string;ofId:number;kind:'SOURCE'|'REMNANT';key:string;reason:string},audit:AuditContext){
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`stock-compensation:${input.movementId}`]);
  const owned=(await tx.query(`SELECT m.id FROM public.stock_movements m WHERE m.id=$1::uuid AND (
    ($3='SOURCE' AND EXISTS(SELECT 1 FROM public.production_material_debit_sources s JOIN public.production_material_debits d ON d.id=s.debit_id WHERE s.stock_movement_id=m.id AND d.of_id=$2 AND d.compensates_id IS NULL)) OR
    ($3='REMNANT' AND EXISTS(SELECT 1 FROM public.production_material_remnants r JOIN public.production_material_debits d ON d.id=r.debit_id WHERE r.stock_movement_id=m.id AND d.of_id=$2))) FOR UPDATE OF m`,[input.movementId,input.ofId,input.kind])).rows[0];
  const existing=(await tx.query(`SELECT id FROM public.stock_movements WHERE reversal_of_id=$1::uuid AND status::text<>'CANCELLED'`,[input.movementId])).rows[0];
  if(!owned||existing)throw new HttpError(409,'MATERIAL_MOVEMENT_ALREADY_CORRECTED','Une écriture de ce débit a déjà été corrigée ou ne lui appartient pas.');
  const original=await repoGetMovement(input.movementId,tx);
  if(!original||original.movement.status!=='POSTED'||original.lines.length!==1||original.movement.movement_type!==(input.kind==='SOURCE'?'OUT':'IN'))
    throw new HttpError(409,'MATERIAL_MOVEMENT_NOT_CORRECTABLE','L’écriture d’origine ne peut pas être compensée par ce débit.');
  const line=original.lines[0],qty=Math.abs(line.qty);
  if(input.kind==='REMNANT'){
    const used=(await tx.query(`SELECT 1 FROM public.stock_lot_genealogy_edges WHERE parent_lot_id=$1::uuid
      UNION ALL SELECT 1 FROM public.stock_reservations WHERE lot_id=$1::uuid AND(status='ACTIVE' OR qty_consumed>0)
      UNION ALL SELECT 1 FROM public.stock_movement_lines ml JOIN public.stock_movements m ON m.id=ml.movement_id
        WHERE ml.lot_id=$1::uuid AND m.id<>$2::uuid AND m.status::text<>'CANCELLED' LIMIT 1`,[line.lot_id,input.movementId])).rows[0];
    if(used)throw new HttpError(409,'MATERIAL_REMNANT_ALREADY_USED','La chute a été déplacée, réservée ou utilisée. Faites traiter son devenir avant de corriger le débit.');
  }
  const created=await repoCreateMovement({movement_type:input.kind==='SOURCE'?'IN':'ADJUSTMENT',source_document_type:'STOCK_COMPENSATION',source_document_id:input.movementId,
    reason_code:'COMPENSATION',notes:input.reason,idempotency_key:`${input.key}:create`,lines:[{article_id:line.article_id,lot_id:line.lot_id,qty,unite:line.unite,
      unit_cost:line.unit_cost,currency:line.currency,note:input.reason,...(input.kind==='SOURCE'?{dst_magasin_id:line.src_magasin_id,dst_emplacement_id:line.src_emplacement_id}:
        {src_magasin_id:line.dst_magasin_id,src_emplacement_id:line.dst_emplacement_id,direction:'OUT' as const})}]},audit,{client:tx,trusted_source_flow:true});
  await tx.query('UPDATE public.stock_movements SET reversal_of_id=$2::uuid WHERE id=$1::uuid',[created.movement.id,input.movementId]);
  const posted=await repoPostMovement(created.movement.id,{},audit,`${input.key}:post`,tx);
  if(posted?.movement.status!=='POSTED')throw new HttpError(409,'MATERIAL_COMPENSATION_NOT_POSTED','La compensation stock a échoué ; aucune correction n’est conservée.');
  return {movementId:created.movement.id,quantity:qty};
}

export async function restoreMaterialReservationTx(tx:PoolClient,input:{reservationId:string;quantity:number;reason:string},audit:AuditContext){
  const r=(await tx.query<{stock_level_id:string;stock_batch_id:string;qty_consumed:number;status:string;unexpired:boolean}>(`SELECT b.stock_level_id::text,r.stock_batch_id::text,r.qty_consumed::float8,r.status,
    (r.expires_at IS NULL OR r.expires_at>now()) AS unexpired FROM public.stock_reservations r JOIN public.stock_batches b ON b.id=r.stock_batch_id
    WHERE r.id=$1::uuid FOR UPDATE OF r`,[input.reservationId])).rows[0];
  if(!r||!['ACTIVE','CONSUMED'].includes(r.status)||!r.unexpired||r.qty_consumed<input.quantity)
    throw new HttpError(409,'MATERIAL_RESERVATION_NOT_RESTORABLE','La réservation a expiré ou changé. Le stock doit vérifier sa destination avant de corriger le débit.');
  const target={stock_level_id:r.stock_level_id,stock_batch_id:r.stock_batch_id};
  const state=(await lockStockStates(tx,[target])).get(stockTargetKey(target));
  if(!state)throw new HttpError(409,'STOCK_LEVEL_MISSING','Le stock remis à disposition est introuvable.');
  if(state.qty_on_hand-state.qty_reserved-state.qty_depreciated+1e-9<input.quantity)
    throw new HttpError(409,'MATERIAL_RESERVATION_NOT_RESTORABLE','La quantité remise en stock ne suffit plus à restaurer la réservation.');
  // The inverse IN has already restored exactly this quantity under the same
  // lot/stock locks. It returns to the original still-active reservation.
  await tx.query('UPDATE public.stock_levels SET qty_reserved=qty_reserved+$2,updated_at=now(),updated_by=$3 WHERE id=$1::uuid',[r.stock_level_id,input.quantity,audit.user_id]);
  await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved+$2 WHERE id=$1::uuid',[r.stock_batch_id,input.quantity]);
  await tx.query(`UPDATE public.stock_reservations SET qty_consumed=qty_consumed-$2,status='ACTIVE',updated_at=now(),updated_by=$3,reason=$4
    WHERE id=$1::uuid`,[input.reservationId,input.quantity,audit.user_id,input.reason]);
}
