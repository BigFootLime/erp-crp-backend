import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {partialReservationConsumption} from '../domain/partial-reservation-consumption';
import {assertOperationalLotQualityEligibility} from '../../qualite/repository/quality-operational-gate.repository';
import {assertStockConsumptionAllowed,beginStockCommand,completeStockCommand,lockStockStates,stockTargetKey,repoCreateMovement,repoPostMovement,type AuditContext} from './stock.repository';
import { RESERVATION_CONSUMPTION_SOURCE_SQL, ASSEMBLY_CONSUMPTION_PROOF_SQL } from './reserved-consumption-source.sql';

type Input={reservationId:string;ofId:number;operationId:string|null;kind?:'MATIERE'|'CONSOMMABLE';quantity:number;expectedVersion:number;idempotencyKey:string;reason:string;barDiscardAllowance?:number};
type Result={reservationId:string;stockMovementId:string;quantity:number;remaining:number;status:'ACTIVE'|'CONSUMED';extendedQuantity?:number};
type ComponentInput = Omit<Input, 'kind' | 'barDiscardAllowance'> & { requirementId: string };
type ReservedInput = Omit<Input, 'kind'> & { kind?: 'MATIERE' | 'CONSOMMABLE' | 'COMPONENT'; componentRequirementId?: string };

export async function consumeComponentReservationTx(tx: PoolClient, input: ComponentInput, audit: AuditContext): Promise<Result> {
  const { requirementId, ...command } = input;
  const result = await consumeReservationTx(tx, { ...command, kind: 'COMPONENT', componentRequirementId: requirementId }, audit);
  const proof = await tx.query(ASSEMBLY_CONSUMPTION_PROOF_SQL,
    [result.stockMovementId, input.ofId, input.reservationId, requirementId, input.quantity]);
  if (proof.rows.length !== 1) throw new HttpError(409, 'ASSEMBLY_TRACEABILITY_REQUIRED', 'La preuve de sortie des composants est incomplète. Aucune sortie n’est conservée.');
  return result;
}

/** Internal stock command, joined to the debit transaction. The production
 * owner must first lock planning and OF, then all source lots in stable order. */
export async function consumeMaterialReservationTx(tx:PoolClient,input:Input,audit:AuditContext):Promise<Result>{
  return consumeReservationTx(tx, input, audit);
}

async function consumeReservationTx(tx: PoolClient, input: ReservedInput, audit: AuditContext): Promise<Result> {
  const {idempotencyKey,...payload}=input;
  const command=await beginStockCommand(tx,{audit,idempotency_key:idempotencyKey,command_type:'RESERVATION_CONSUME',request_payload:{...payload,partial:true}});
  if(command.existing)return command.existing.result_payload as Result;
  const identity=(await tx.query<{lot_id:string|null}>('SELECT lot_id::text FROM public.stock_reservations WHERE id=$1::uuid',[input.reservationId])).rows[0];
  if(!identity||!identity.lot_id&&input.kind!=='CONSOMMABLE')throw new HttpError(409,'MATERIAL_RESERVATION_LOT_REQUIRED','La réservation doit identifier son lot matière.');
  if(identity.lot_id)await assertOperationalLotQualityEligibility({client:tx,lotId:identity.lot_id,qty:0,purpose:'RESERVE'});
  const row=(await tx.query<{
    article_id:string;lot_id:string|null;stock_batch_id:string|null;stock_level_id:string;magasin_id:string;emplacement_id:number;unit:string;
    qty_reserved:number;qty_consumed:number;qty_prepared:number;row_version:number;status:string;unexpired:boolean;
  }>(RESERVATION_CONSUMPTION_SOURCE_SQL,[input.reservationId,input.ofId,input.operationId,input.kind??'MATIERE',input.componentRequirementId??null])).rows[0];
  if(!row)throw new HttpError(409,'MATERIAL_RESERVATION_MISMATCH','Cette réservation ne couvre pas la matière de cette opération.');
  if(row.status!=='ACTIVE'||!row.unexpired)throw new HttpError(409,'MATERIAL_RESERVATION_EXPIRED','Cette réservation n’est plus active. Revoyez la couverture matière.');
  if(row.row_version!==input.expectedVersion)throw new HttpError(409,'CONCURRENT_MODIFICATION','Cette réservation a changé. Relisez le reliquat avant de débiter.');
  const target={stock_level_id:row.stock_level_id,stock_batch_id:row.stock_batch_id};
  const state=(await lockStockStates(tx,[target])).get(stockTargetKey(target));
  if(!state)throw new HttpError(409,'STOCK_LEVEL_MISSING','Le stock du lot ne peut pas être vérifié.');
  const extra=Math.max(0,input.quantity-(row.qty_reserved-row.qty_consumed));
  if(extra>0){
    // Only the explicitly measured discarded end of a bar may extend this
    // reservation. Free stock and quality release are rechecked under locks.
    if(!Number.isFinite(input.barDiscardAllowance)||extra>(input.barDiscardAllowance??0)+1e-9||input.kind==='CONSOMMABLE'||input.kind==='COMPONENT')
      throw new HttpError(409,'MATERIAL_DEBIT_RESERVATION_EXCEEDED','Le prélèvement dépasse la réservation.');
    if(row.lot_id)await assertOperationalLotQualityEligibility({client:tx,lotId:row.lot_id,qty:extra,unit:row.unit,purpose:'RESERVE'});
    assertStockConsumptionAllowed(state,{movement_type:'RESERVE',qty:extra});
    await tx.query('UPDATE public.stock_levels SET qty_reserved=qty_reserved+$2,updated_at=now(),updated_by=$3 WHERE id=$1::uuid',[row.stock_level_id,extra,audit.user_id]);
    if(row.stock_batch_id)await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved+$2 WHERE id=$1::uuid',[row.stock_batch_id,extra]);
    await tx.query('UPDATE public.stock_reservations SET qty_reserved=qty_reserved+$2,updated_at=now(),updated_by=$3 WHERE id=$1::uuid',[input.reservationId,extra,audit.user_id]);
    row.qty_reserved+=extra;state.qty_reserved+=extra;
  }
  const next=partialReservationConsumption({reserved:row.qty_reserved,consumed:row.qty_consumed,prepared:row.qty_prepared,quantity:input.quantity});
  assertStockConsumptionAllowed(state,{movement_type:'UNRESERVE',qty:next.unreserve});
  await tx.query('UPDATE public.stock_levels SET qty_reserved=qty_reserved-$2,updated_at=now(),updated_by=$3 WHERE id=$1::uuid',[row.stock_level_id,next.unreserve,audit.user_id]);
  if(row.stock_batch_id)await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved-$2 WHERE id=$1::uuid',[row.stock_batch_id,next.unreserve]);
  const reasonCode = input.kind === 'COMPONENT' ? 'PRELEVEMENT_COMPOSANT' : input.kind === 'CONSOMMABLE' ? 'PRELEVEMENT_CONSOMMABLE' : 'DEBIT_MATIERE';
  const created=await repoCreateMovement({movement_type:'OUT',source_document_type:'OF',source_document_id:String(input.ofId),reason_code:reasonCode,notes:input.reason,
    idempotency_key:`${command.key}:movement`,lines:[{article_id:row.article_id,lot_id:row.lot_id,qty:input.quantity,unite:row.unit,src_magasin_id:row.magasin_id,src_emplacement_id:row.emplacement_id,note:input.reason}]},audit,{client:tx,trusted_source_flow:true});
  const movementId=created.movement.id;
  // This link also lets the canonical material-consumption ledger attach the
  // posted movement to this reservation, including for several partial issues.
  await tx.query(`UPDATE public.stock_reservations SET qty_consumed=$2,qty_prepared=$3,status=$4,consumed_stock_movement_id=$5::uuid,
    consumed_at=now(),consumed_by=$6,updated_at=now(),updated_by=$6,reason=$7 WHERE id=$1::uuid`,[input.reservationId,next.consumed,next.prepared,next.status,movementId,audit.user_id,input.reason]);
  const posted=await repoPostMovement(movementId,{},audit,`${command.key}:post`,tx,{reservationId:input.reservationId});
  if(posted?.movement.status!=='POSTED')throw new HttpError(409,'MATERIAL_CONSUMPTION_NOT_POSTED','La sortie matière n’a pas été comptabilisée. Aucun débit n’est conservé.');
  const result:Result={reservationId:input.reservationId,stockMovementId:movementId,quantity:input.quantity,remaining:next.remaining,status:next.status,extendedQuantity:extra};
  await completeStockCommand(tx,{audit,command,command_type:'RESERVATION_CONSUME',resource_type:'stock_reservation',resource_id:input.reservationId,result_payload:result});
  return result;
}
