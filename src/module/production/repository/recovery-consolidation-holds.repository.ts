import type { PoolClient } from 'pg';
import type { AuditContext } from './production.repository';
import { HttpError } from '../../../utils/httpError';
import { quantity } from '../domain/of-material';
import { readRecoveryConsolidationMaterialTx } from './recovery-consolidation-material.repository';
import { HOLD_SELECT, type HoldRow } from './consolidation-material-holds.repository';
import { assertStockConsumptionAllowed, lockStockStates, stockTargetKey } from '../../stock/repository/stock.repository';

function changed(): never { throw new HttpError(409,'RECOVERY_MATERIAL_CHANGED','La matière a changé. Actualisez la proposition de regroupement.'); }
const physicalKey = (row: HoldRow) => `${row.material_need_id}:${row.article_id}:${row.location_id}:${row.lot_id}`;
type Evidence = {producer_reservation_id:string;producer_need_id:string;total_reserved:number};
export type RecoveryHoldInput = {
  consolidationId:string;recoveryId:string;producerId:number;recoveryOfId:number;materialVersion:string;
};

/** Private part of the planner's SERIALIZABLE grouping transaction. The caller
 * holds the planning revision and both OF rows, then commits the exact source
 * allocation, quantity extension, dossier and planning changes together.
 * No stock movement occurs: these units were already physically reserved.
 * Deferred SQL constraints refuse a transfer without its recovery allocation. */
export async function appendRecoveryConsolidationHoldsTx(tx:PoolClient,input:RecoveryHoldInput,audit:AuditContext) {
  const context=(await tx.query<{valid:boolean}>(`SELECT (g.state='ACTIVE' AND g.producer_of_id=$3::bigint
    AND r.recovery_of_id=$4::bigint AND request.status IN ('WAITING_PLANNER','APPROVED','WITHDRAWN')) AS valid
    FROM public.production_consolidations g CROSS JOIN public.delivery_urgency_recoveries r
    JOIN public.delivery_urgency_requests request ON request.id=r.request_id
    WHERE g.id=$1::uuid AND r.id=$2::uuid FOR UPDATE OF g,request`,
  [input.consolidationId,input.recoveryId,input.producerId,input.recoveryOfId])).rows[0];
  if(!context?.valid||input.producerId===input.recoveryOfId)changed();
  const replay=await tx.query(`SELECT e.reservation_id FROM public.production_recovery_material_extensions e
    JOIN public.production_consolidations g ON g.id=e.consolidation_id
    WHERE recovery_id=$1::uuid AND g.state='ACTIVE' LIMIT 1`,[input.recoveryId]);
  if(replay.rows.length)changed(); // Request-level replay is handled before any mutation.
  const initial=await readRecoveryConsolidationMaterialTx(tx,input.producerId,input.recoveryOfId);
  if(!initial.ready||initial.version!==input.materialVersion)changed();
  // Include expired active holds too, so a conflicting old hold is reported as
  // stale instead of surfacing the stock reservation unique index to the user.
  const ids=(await tx.query<{id:string}>(`SELECT id::text FROM public.stock_reservations
    WHERE of_id=ANY($1::bigint[]) AND status IN ('ACTIVE','CONSUMED') ORDER BY id`,
  [[input.producerId,input.recoveryOfId]])).rows.map(r=>r.id);
  // Same lock order as the operational quality and dissolution paths.
  await tx.query(`SELECT l.id FROM public.lots l WHERE l.id IN
    (SELECT lot_id FROM public.stock_reservations WHERE id=ANY($1::uuid[])) ORDER BY l.id FOR UPDATE`,[ids]);
  const unlocked=(await tx.query<HoldRow>(`${HOLD_SELECT} WHERE r.id=ANY($1::uuid[]) ORDER BY r.id`,[ids])).rows;
  const states=await lockStockStates(tx,unlocked.flatMap(r=>[
    {stock_level_id:r.stock_level_id,stock_batch_id:r.stock_batch_id},
    {stock_level_id:r.stock_level_id,stock_batch_id:null},
  ]));
  const rows=(await tx.query<HoldRow>(`${HOLD_SELECT} WHERE r.id=ANY($1::uuid[]) ORDER BY r.id FOR UPDATE OF r`,[ids])).rows;
  if(rows.length!==ids.length)changed();
  const material=await readRecoveryConsolidationMaterialTx(tx,input.producerId,input.recoveryOfId);
  if(!material.ready||material.version!==input.materialVersion)changed();
  const holds=(await tx.query<Evidence>(`SELECT h.producer_reservation_id::text,h.producer_need_id::text,
    (h.transferred_qty+h.surplus_qty+COALESCE((SELECT sum(e.quantity) FROM public.production_recovery_material_extensions e
      WHERE e.consolidation_id=h.consolidation_id AND e.producer_reservation_id=h.producer_reservation_id
        AND NOT e.included_in_base),0))::float8 AS total_reserved
    FROM public.production_consolidation_material_holds h WHERE h.consolidation_id=$1::uuid`,[input.consolidationId])).rows;
  const byId=new Map(rows.map(r=>[r.id,r])),evidence=new Map(holds.map(h=>[h.producer_reservation_id,h]));
  const actions:Array<{source:HoldRow;target:HoldRow|null;needId:string}>=[];
  const used=new Set<string>(),targets=new Set<string>();
  for(const group of material.groups) {
    if(!group.producer_need_id||!group.recovery_need_id)changed();
    for(const id of group.recovery_reservation_ids) {
      const source=byId.get(id);
      if(!source||used.has(id)||source.of_id!==input.recoveryOfId||source.material_need_id!==group.recovery_need_id
        ||source.article_id!==group.article_id||source.status!=='ACTIVE'||!source.unexpired
        ||source.source_type!=='OF'||source.source_id!==String(input.recoveryOfId)||!source.lot_id||!source.stock_batch_id
        ||Number(source.qty_consumed)!==0||Number(source.qty_prepared)!==0||Number(source.qty_reserved)<=0)changed();
      used.add(id);
      const matches=rows.filter(r=>r.of_id===input.producerId&&r.status==='ACTIVE'
        &&physicalKey(r)===physicalKey({...source,material_need_id:group.producer_need_id!}));
      if(matches.length>1)changed();
      const target=matches[0]??null;
      const key=physicalKey({...source,material_need_id:group.producer_need_id!});
      if(targets.has(key))changed();
      targets.add(key);
      if(target) {
        const proof=evidence.get(target.id);
        if(!target.unexpired||target.source_type!=='OF'||target.source_id!==String(input.producerId)
          ||target.stock_batch_id!==source.stock_batch_id||!proof||proof.producer_need_id!==group.producer_need_id
          ||quantity(proof.total_reserved)!==quantity(Number(target.qty_reserved))
          ||Number(target.qty_consumed)<0||Number(target.qty_consumed)>Number(target.qty_reserved))changed();
      }
      actions.push({source,target,needId:group.producer_need_id!});
    }
  }
  // Every source unit must still be backed by the same physical stock counters.
  const totals=new Map<string,{stock_level_id:string;stock_batch_id:string|null;qty:number}>();
  for(const {source} of actions)for(const batch of [source.stock_batch_id,null]) {
    const key=stockTargetKey({stock_level_id:source.stock_level_id,stock_batch_id:batch});
    const total=totals.get(key)??{stock_level_id:source.stock_level_id,stock_batch_id:batch,qty:0};
    total.qty=quantity(total.qty+Number(source.qty_reserved));totals.set(key,total);
  }
  for(const [key,total]of totals) {
    const state=states.get(key);if(!state)changed();
    assertStockConsumptionAllowed(state,{movement_type:'UNRESERVE',qty:total.qty});
  }
  const transferred=[];
  for(const {source,target,needId}of actions) {
    let targetId=target?.id;
    if(target) {
      await tx.query(`UPDATE public.stock_reservations SET qty_reserved=qty_reserved+$2,
        expires_at=LEAST(expires_at,(SELECT expires_at FROM public.stock_reservations WHERE id=$5::uuid)),
        updated_at=now(),updated_by=$3,correlation_id=$4::uuid WHERE id=$1::uuid`,
      [target.id,source.qty_reserved,audit.user_id,input.consolidationId,source.id]);
    }else {
      targetId=(await tx.query<{id:string}>(`INSERT INTO public.stock_reservations
        (article_id,location_id,lot_id,stock_batch_id,qty_reserved,source_type,source_id,of_id,material_need_id,status,
         expires_at,reason,correlation_id,created_by,updated_by)
        SELECT article_id,location_id,lot_id,stock_batch_id,qty_reserved,'OF',$2::bigint::text,$2::bigint,$3::uuid,'ACTIVE',
          expires_at,'Matière de récupération ajoutée au regroupement',$4::uuid,$5,$5
        FROM public.stock_reservations WHERE id=$1::uuid RETURNING id::text`,
      [source.id,input.producerId,needId,input.consolidationId,audit.user_id])).rows[0]?.id;
      if(!targetId)changed();
      await tx.query(`INSERT INTO public.production_consolidation_material_holds
        (consolidation_id,producer_reservation_id,producer_need_id,transferred_qty,surplus_qty)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,0)`,[input.consolidationId,targetId,needId,source.qty_reserved]);
    }
    await tx.query(`INSERT INTO public.production_consolidation_material_transfers
      (consolidation_id,reservation_id,source_of_id,source_need_id,producer_need_id,producer_reservation_id,source_reserved_qty)
      VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7)`,
    [input.consolidationId,source.id,input.recoveryOfId,source.material_need_id,needId,targetId,source.qty_reserved]);
    await tx.query(`UPDATE public.stock_reservations SET status='RELEASED',released_at=now(),released_by=$2,
      updated_at=now(),updated_by=$2,correlation_id=$3::uuid,reason='Matière transférée au regroupement de récupération'
      WHERE id=$1::uuid`,[source.id,audit.user_id,input.consolidationId]);
    await tx.query(`INSERT INTO public.production_recovery_material_extensions
      (consolidation_id,reservation_id,recovery_id,producer_reservation_id,quantity,included_in_base,
       producer_reserved_before,producer_consumed_before,producer_prepared_before,created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10)`,
    [input.consolidationId,source.id,input.recoveryId,targetId,source.qty_reserved,!target,
      target?.qty_reserved??0,target?.qty_consumed??0,target?.qty_prepared??0,audit.user_id]);
    transferred.push({source_reservation_id:source.id,producer_reservation_id:targetId!,quantity:Number(source.qty_reserved)});
  }
  return transferred;
}
