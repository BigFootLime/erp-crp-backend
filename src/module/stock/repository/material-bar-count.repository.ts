import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { materialBarInventoryCommand, type MaterialBarInventoryCommand } from '../validators/material-bars.validators';
import { lockMaterialBarInventoryTx, readMaterialBarInventoryTx, proposedBarInventory, writeMaterialBarInventoryTx,
  type MaterialBarInventory } from './material-bar-inventory.repository';
import { lockMaterialBarPostingScopeTx } from './material-bar-posting.repository';
import { lockMaterialBarReceiptLotTx } from './material-bar-receipt.repository';

type Db = Pick<PoolClient,'query'>;
export type MaterialBarCountLine = { snapshotId:string; batchId:string|null; articleId:string; lotId:string|null;
  theoreticalQty:number; countedQty:number; countEventId:string };
export type PreparedMaterialBarCount = Readonly<{ kind:'MATERIAL_BAR_COUNT' }>;
type CountPlan = { current:MaterialBarInventory; body:MaterialBarInventoryCommand; countedQty:number; geometryChanged:boolean };
const plans = new WeakMap<PreparedMaterialBarCount,{ tx:Db; plan:CountPlan; line:MaterialBarCountLine; sessionId:string }>();
const milli=(n:number)=>Math.round(n*1000);
function conflict(message:string):never { throw new HttpError(409,'MATERIAL_BAR_COUNT_CHANGED',message); }

/** Counted geometry may differ from the ledger but must cover the exact measured
 * total and every live reservation. The snapshot itself remains untouched. */
export function validateMaterialBarCount(current:MaterialBarInventory, body:MaterialBarInventoryCommand, countedQty:number):CountPlan {
  if (!Number.isFinite(countedQty) || countedQty<0 || countedQty>1e9 || Math.abs(countedQty*1000-milli(countedQty))>1e-6)
    throw new HttpError(422,'MATERIAL_BAR_COUNT_INVALID','La longueur totale doit avoir au maximum trois décimales.');
  const measured=body.bars.reduce((sum,b)=>sum+milli(b.lengthMm),0);
  if (measured!==milli(countedQty)) throw new HttpError(422,'MATERIAL_BAR_COUNT_TOTAL_MISMATCH','Le total doit correspondre aux longueurs des barres comptées.');
  proposedBarInventory({...current,batch:{...current.batch,physicalMm:countedQty}},body);
  const geometry=(bars:ReadonlyArray<{id:string;lengthMm:number}>)=>bars.filter(b=>b.lengthMm>0)
    .map(b=>[b.id,milli(b.lengthMm)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  const allocations=(holds:ReadonlyArray<{barId:string;reservationId:string;remainingMm:number}>)=>holds.filter(h=>h.remainingMm>0)
    .map(h=>[h.barId,h.reservationId,milli(h.remainingMm)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const nextHolds=body.bars.flatMap(b=>b.allocations.map(a=>({barId:b.id,reservationId:a.reservationId,remainingMm:a.quantityMm})));
  const geometryChanged=current.status!=='CONFIRMED' || JSON.stringify([geometry(current.bars),allocations(current.holds)])
    !==JSON.stringify([geometry(body.bars),allocations(nextHolds)]);
  return {current,body,countedQty,geometryChanged};
}

async function enabled(tx:Db,line:Pick<MaterialBarCountLine,'batchId'|'articleId'|'lotId'>,explicit:boolean) {
  const scope=await lockMaterialBarPostingScopeTx(tx,{articleId:line.articleId,lotIds:line.lotId?[line.lotId]:[],explicit});
  if (!scope.enabled) return false;
  const tracked=line.batchId && (await tx.query(`SELECT 1 FROM public.stock_material_bar_inventories WHERE stock_batch_id=$1::uuid`,[line.batchId])).rows.length>0;
  if (!scope.required && !tracked && !explicit) return false;
  if (!line.batchId || !line.lotId) throw new HttpError(422,'MATERIAL_BAR_BATCH_REQUIRED','Le comptage des barres doit être rattaché à un lot et un emplacement.');
  const installed=(await tx.query<{installed:boolean}>(`SELECT to_regclass('public.stock_inventory_material_bar_counts') IS NOT NULL AS installed`)).rows[0]?.installed;
  if (!installed) throw new HttpError(409,'MATERIAL_BAR_COUNT_NOT_INSTALLED','La mise à jour du comptage des barres doit précéder cet inventaire.');
  return true;
}

export async function prepareMaterialBarCountEntryTx(tx:Db,input:{line:Omit<MaterialBarCountLine,'countEventId'>;body?:MaterialBarInventoryCommand}) {
  if (!await enabled(tx,input.line,!!input.body)) return null;
  if (!input.body) throw new HttpError(422,'MATERIAL_BAR_COUNT_REQUIRED','Renseignez les barres présentes et leurs longueurs pour ce comptage.');
  const current=await lockMaterialBarInventoryTx(tx,input.line.batchId!);
  if (current.batch.articleId!==input.line.articleId || current.batch.lotId!==input.line.lotId
    || milli(current.batch.physicalMm)!==milli(input.line.theoreticalQty))
    conflict('Le stock a changé depuis l’ouverture de cet inventaire. Reprenez son périmètre avant de compter.');
  const plan=validateMaterialBarCount(current,input.body,input.line.countedQty);
  const newIds=input.body.bars.filter(b=>!current.bars.some(old=>old.id===b.id)).map(b=>b.id);
  if(newIds.length && (await tx.query('SELECT id FROM public.stock_material_bars WHERE id=ANY($1::uuid[])',[newIds])).rows.length)
    throw new HttpError(409,'MATERIAL_BAR_IDENTITY_USED','Une barre appartient déjà à un autre emplacement ou à un ancien relevé. Actualisez le comptage.');
  return plan;
}

export async function recordMaterialBarCountTx(tx:Db,countEventId:string,plan:CountPlan) {
  await tx.query(`INSERT INTO public.stock_inventory_material_bar_counts(count_event_id,stock_batch_id,geometry_changed,measurement)
    VALUES($1::uuid,$2::uuid,$3,$4::jsonb)`,[countEventId,plan.current.batch.id,plan.geometryChanged,JSON.stringify(plan.body)]);
}

export async function loadMaterialBarCountLinesTx(tx:Db,sessionId:string):Promise<MaterialBarCountLine[]> {
  return (await tx.query<MaterialBarCountLine>(`SELECT s.id::text AS "snapshotId",s.stock_batch_id::text AS "batchId",
    s.article_id::text AS "articleId",s.lot_id::text AS "lotId",s.theoretical_qty::float8 AS "theoreticalQty",
    e.id::text AS "countEventId",e.counted_qty::float8 AS "countedQty"
    FROM public.stock_inventory_snapshot_lines s JOIN LATERAL (
      SELECT id,counted_qty FROM public.stock_inventory_count_events WHERE snapshot_line_id=s.id
      ORDER BY count_round DESC,created_at DESC,id DESC LIMIT 1
    ) e ON true WHERE s.session_id=$1::uuid ORDER BY s.id`,[sessionId])).rows;
}

export async function readMaterialBarCountsTx(tx:Db,countEventIds:string[]) {
  const found=new Map<string,MaterialBarInventoryCommand>();
  if(!countEventIds.length) return found;
  const installed=(await tx.query<{installed:boolean}>(`SELECT to_regclass('public.stock_inventory_material_bar_counts') IS NOT NULL AS installed`)).rows[0]?.installed;
  if(!installed) return found;
  const rows=(await tx.query<{id:string;measurement:unknown}>(`SELECT count_event_id::text AS id,measurement
    FROM public.stock_inventory_material_bar_counts WHERE count_event_id=ANY($1::uuid[])`,[countEventIds])).rows;
  for(const row of rows) {
    const parsed=materialBarInventoryCommand.safeParse(row.measurement);
    if(!parsed.success) conflict('Un relevé de barres est incomplet. Consultez l’historique de cet inventaire.');
    found.set(row.id,parsed.data);
  }
  return found;
}

/** Called both before approval and before closing. No physical stock is changed
 * until the canonical adjustment has posted in the same transaction. */
export async function prepareMaterialBarCountSessionTx(tx:Db,sessionId:string,lines:MaterialBarCountLine[],requiresSecondCount=false) {
  // Lock shared lots before any stock level/batch, including across articles.
  for(const lot of [...new Set(lines.flatMap(l=>l.lotId?[l.lotId]:[]))].sort()) await lockMaterialBarReceiptLotTx(tx,lot);
  const recorded=await readMaterialBarCountsTx(tx,lines.map(l=>l.countEventId));
  const result=new Map<string,PreparedMaterialBarCount>();
  for(const line of [...lines].sort((a,b)=>(a.batchId??'').localeCompare(b.batchId??''))) {
    if (!await enabled(tx,line,recorded.has(line.countEventId))) continue;
    const record=(await tx.query<{measurement:unknown;batchId:string;sessionId:string;snapshotId:string;countedQty:number;round:number}>(`SELECT c.measurement,c.stock_batch_id::text AS "batchId",
      e.session_id::text AS "sessionId",e.snapshot_line_id::text AS "snapshotId",e.counted_qty::float8 AS "countedQty",e.count_round AS round
      FROM public.stock_inventory_material_bar_counts c JOIN public.stock_inventory_count_events e ON e.id=c.count_event_id
      WHERE c.count_event_id=$1::uuid`,[line.countEventId])).rows[0];
    if (!record) throw new HttpError(422,'MATERIAL_BAR_COUNT_REQUIRED','Un comptage matière ne contient pas le détail des barres. Complétez-le avant validation.');
    const parsed=materialBarInventoryCommand.safeParse(record.measurement);
    if (!parsed.success || record.batchId!==line.batchId || record.sessionId!==sessionId || record.snapshotId!==line.snapshotId
      || milli(record.countedQty)!==milli(line.countedQty)) conflict('Le relevé physique ne correspond pas à cette ligne d’inventaire.');
    const plan=await prepareMaterialBarCountEntryTx(tx,{line,body:parsed.data});
    if (!plan) conflict('Le suivi matière de cette ligne a changé.');
    if (requiresSecondCount && plan.geometryChanged && record.round!==2)
      throw new HttpError(409,'INVENTORY_SECOND_COUNTS_INCOMPLETE','Un second comptage est requis : les barres diffèrent, même si leur longueur totale est identique.');
    const token=Object.freeze({kind:'MATERIAL_BAR_COUNT' as const});plans.set(token,{tx,plan,line,sessionId});result.set(line.snapshotId,token);
  }
  return result;
}

export async function applyMaterialBarCountTx(tx:Db,token:PreparedMaterialBarCount,movementId:string|null,actor:number) {
  const entry=plans.get(token);if(!entry || entry.tx!==tx) conflict('Préparez le comptage dans la transaction de clôture.');
  const {plan,line,sessionId}=entry,delta=(milli(line.countedQty)-milli(line.theoreticalQty))/1000;
  if ((delta!==0)!==!!movementId) conflict('L’ajustement de stock ne correspond pas à l’écart compté.');
  if(movementId) {
    const ledger=(await tx.query<{ok:number}>(`SELECT 1 AS ok FROM public.stock_movements m
      JOIN public.stock_inventory_session_movements link ON link.stock_movement_id=m.id
      WHERE m.id=$1::uuid AND m.status='POSTED' AND m.movement_type='ADJUSTMENT' AND m.qty=$2
        AND m.stock_batch_id=$3::uuid AND m.article_id=$4::uuid AND link.session_id=$5::uuid AND link.snapshot_line_id=$6::uuid`,
    [movementId,delta,line.batchId,line.articleId,sessionId,line.snapshotId])).rows[0];
    if(!ledger) conflict('L’écriture d’ajustement ne correspond pas au comptage approuvé.');
  }
  const current=await readMaterialBarInventoryTx(tx,line.batchId!);
  if(current.revision!==plan.current.revision || current.batch.reservedMm!==plan.current.batch.reservedMm
    || JSON.stringify([current.bars,current.holds,current.reservations])!==JSON.stringify([plan.current.bars,plan.current.holds,plan.current.reservations])
    || milli(current.batch.physicalMm)!==milli(plan.countedQty)
    || BigInt(current.batch.movementCount)!==BigInt(plan.current.batch.movementCount)+BigInt(delta===0?0:1))
    conflict('Le stock ou les réservations ont changé pendant la clôture.');
  const result=await writeMaterialBarInventoryTx(tx,current,{...plan.body,expectedVersion:current.version},actor,line.countEventId);
  if(result.status!=='CONFIRMED') conflict('Les barres et le stock ne correspondent pas après le comptage.');
  plans.delete(token);return result;
}
