import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {partialReservationConsumption} from '../domain/partial-reservation-consumption';
import {assertOperationalLotQualityEligibility} from '../../qualite/repository/quality-operational-gate.repository';
import {assertStockConsumptionAllowed,beginStockCommand,completeStockCommand,lockStockStates,stockTargetKey,repoCreateMovement,repoPostMovement,type AuditContext} from './stock.repository';

type Input={reservationId:string;ofId:number;operationId:string;quantity:number;expectedVersion:number;idempotencyKey:string;reason:string};
type Result={reservationId:string;stockMovementId:string;quantity:number;remaining:number;status:'ACTIVE'|'CONSUMED'};

/** Internal stock command, joined to the debit transaction. The production
 * owner must first lock planning and OF, then all source lots in stable order. */
export async function consumeMaterialReservationTx(tx:PoolClient,input:Input,audit:AuditContext):Promise<Result>{
  const {idempotencyKey,...payload}=input;
  const command=await beginStockCommand(tx,{audit,idempotency_key:idempotencyKey,command_type:'RESERVATION_CONSUME',request_payload:{...payload,partial:true}});
  if(command.existing)return command.existing.result_payload as Result;
  const identity=(await tx.query<{lot_id:string|null}>('SELECT lot_id::text FROM public.stock_reservations WHERE id=$1::uuid',[input.reservationId])).rows[0];
  if(!identity?.lot_id)throw new HttpError(409,'MATERIAL_RESERVATION_LOT_REQUIRED','La réservation doit identifier son lot matière.');
  await assertOperationalLotQualityEligibility({client:tx,lotId:identity.lot_id,qty:0,purpose:'RESERVE'});
  const row=(await tx.query<{
    article_id:string;lot_id:string;stock_batch_id:string;stock_level_id:string;magasin_id:string;emplacement_id:number;unit:string;
    qty_reserved:number;qty_consumed:number;qty_prepared:number;row_version:number;status:string;unexpired:boolean;
  }>(`SELECT r.article_id::text,r.lot_id::text,r.stock_batch_id::text,b.stock_level_id::text,e.magasin_id::text,e.id::int AS emplacement_id,a.unite AS unit,
    r.qty_reserved::float8,r.qty_consumed::float8,r.qty_prepared::float8,r.row_version,r.status,(r.expires_at IS NULL OR r.expires_at>now()) AS unexpired
    FROM public.stock_reservations r JOIN public.v_of_material_need_destinations destination ON destination.source_need_id=r.material_need_id
    JOIN public.of_material_needs n ON n.id=destination.target_need_id
    JOIN public.stock_batches b ON b.id=r.stock_batch_id AND b.lot_id=r.lot_id
    JOIN public.stock_levels s ON s.id=b.stock_level_id AND s.article_id=r.article_id AND s.location_id=r.location_id
    JOIN public.emplacements e ON e.location_id=r.location_id JOIN public.articles a ON a.id=r.article_id
    WHERE r.id=$1::uuid AND r.of_id=$2 AND n.of_id=$2 AND n.operation_id=$3::uuid AND n.superseded_at IS NULL
    FOR UPDATE OF r`,[input.reservationId,input.ofId,input.operationId])).rows[0];
  if(!row)throw new HttpError(409,'MATERIAL_RESERVATION_MISMATCH','Cette réservation ne couvre pas la matière de cette opération.');
  if(row.status!=='ACTIVE'||!row.unexpired)throw new HttpError(409,'MATERIAL_RESERVATION_EXPIRED','Cette réservation n’est plus active. Revoyez la couverture matière.');
  if(row.row_version!==input.expectedVersion)throw new HttpError(409,'CONCURRENT_MODIFICATION','Cette réservation a changé. Relisez le reliquat avant de débiter.');
  const next=partialReservationConsumption({reserved:row.qty_reserved,consumed:row.qty_consumed,prepared:row.qty_prepared,quantity:input.quantity});
  const target={stock_level_id:row.stock_level_id,stock_batch_id:row.stock_batch_id};
  const state=(await lockStockStates(tx,[target])).get(stockTargetKey(target));
  if(!state)throw new HttpError(409,'STOCK_LEVEL_MISSING','Le stock du lot ne peut pas être vérifié.');
  assertStockConsumptionAllowed(state,{movement_type:'UNRESERVE',qty:next.unreserve});
  await tx.query('UPDATE public.stock_levels SET qty_reserved=qty_reserved-$2,updated_at=now(),updated_by=$3 WHERE id=$1::uuid',[row.stock_level_id,next.unreserve,audit.user_id]);
  await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved-$2 WHERE id=$1::uuid',[row.stock_batch_id,next.unreserve]);
  const created=await repoCreateMovement({movement_type:'OUT',source_document_type:'OF',source_document_id:String(input.ofId),reason_code:'DEBIT_MATIERE',notes:input.reason,
    idempotency_key:`${command.key}:movement`,lines:[{article_id:row.article_id,lot_id:row.lot_id,qty:input.quantity,unite:row.unit,src_magasin_id:row.magasin_id,src_emplacement_id:row.emplacement_id,note:input.reason}]},audit,{client:tx,trusted_source_flow:true});
  const movementId=created.movement.id;
  // This link also lets the canonical material-consumption ledger attach the
  // posted movement to this reservation, including for several partial issues.
  await tx.query(`UPDATE public.stock_reservations SET qty_consumed=$2,qty_prepared=$3,status=$4,consumed_stock_movement_id=$5::uuid,
    consumed_at=now(),consumed_by=$6,updated_at=now(),updated_by=$6,reason=$7 WHERE id=$1::uuid`,[input.reservationId,next.consumed,next.prepared,next.status,movementId,audit.user_id,input.reason]);
  const posted=await repoPostMovement(movementId,{},audit,`${command.key}:post`,tx,{reservationId:input.reservationId});
  if(posted?.movement.status!=='POSTED')throw new HttpError(409,'MATERIAL_CONSUMPTION_NOT_POSTED','La sortie matière n’a pas été comptabilisée. Aucun débit n’est conservé.');
  const result:Result={reservationId:input.reservationId,stockMovementId:movementId,quantity:input.quantity,remaining:next.remaining,status:next.status};
  await completeStockCommand(tx,{audit,command,command_type:'RESERVATION_CONSUME',resource_type:'stock_reservation',resource_id:input.reservationId,result_payload:result});
  return result;
}
