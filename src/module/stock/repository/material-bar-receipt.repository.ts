import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../../utils/httpError';
import { receivedMaterialBarLengths, type ReceivedBarGroup } from '../domain/material-bar-receipt';
import { assertMaterialBarSchema, lockMaterialBarInventoryTx, readMaterialBarInventoryTx, type MaterialBarInventory } from './material-bar-inventory.repository';

type Db = Pick<PoolClient, 'query'>;
export type MaterialBarReceiptPlan = { current: MaterialBarInventory; movementId: string; quantityMm: number; lengths: number[] };

/** Take canonical lot/reservation locks BEFORE movement creation can create or
 * lock the destination batch. Same order as reservation, debit and inventory. */
export async function lockMaterialBarReceiptLotTx(tx: Db, lotId: string) {
  await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE', [lotId]);
  await tx.query(`SELECT r.id FROM public.stock_reservations r JOIN public.stock_batches b ON b.id=r.stock_batch_id
    WHERE b.lot_id=$1::uuid ORDER BY r.id FOR UPDATE OF r`, [lotId]);
}

export async function prepareMaterialBarReceiptTx(tx: Db, input: {
  movementId: string; required: boolean; groups?: readonly ReceivedBarGroup[];
}): Promise<MaterialBarReceiptPlan | null> {
  const installed = (await tx.query<{ installed: boolean }>("SELECT to_regclass('public.stock_material_bar_inventories') IS NOT NULL AS installed")).rows[0]?.installed;
  if (!installed && !input.required && !input.groups) return null;
  await assertMaterialBarSchema(tx);
  const movement = (await tx.query<{ batchId: string | null; quantityMm: number; unit: string; status: string; type: string }>(`SELECT m.stock_batch_id::text AS "batchId",
    m.qty::float8 AS "quantityMm",lower(trim(a.unite)) AS unit,m.status,m.movement_type::text AS type
    FROM public.stock_movements m JOIN public.articles a ON a.id=m.article_id WHERE m.id=$1::uuid FOR UPDATE OF m`, [input.movementId])).rows[0];
  if (!movement || movement.type !== 'IN' || movement.status !== 'DRAFT' || movement.unit !== 'mm' || !movement.batchId)
    throw new HttpError(409, 'MATERIAL_BAR_RECEIPT_MOVEMENT', 'La réception des barres nécessite une entrée matière en millimètres, avec son lot.');
  const current = await lockMaterialBarInventoryTx(tx, movement.batchId);
  if (!input.required && !input.groups && current.status === 'UNCONFIRMED') return null;
  if (!input.groups) throw new HttpError(422, 'MATERIAL_BAR_RECEIPT_REQUIRED', 'Confirmez le nombre et les longueurs des barres reçues.');
  const lengths = receivedMaterialBarLengths(input.groups, movement.quantityMm);
  // A receipt cannot certify the geometry of old stock already in this location.
  if (current.status !== 'CONFIRMED' && !(current.status === 'UNCONFIRMED' && current.batch.physicalMm === 0
    && current.batch.reservedMm === 0 && !current.bars.length && !current.holds.length && !current.reservations.length))
    throw new HttpError(409, 'MATERIAL_BAR_RECEIPT_EXISTING_STOCK', 'Confirmez les barres déjà présentes dans ce lot, ou choisissez un autre emplacement avant la mise en stock.');
  return { current, movementId: input.movementId, quantityMm: movement.quantityMm, lengths };
}

/** Canonical IN is already posted in this same transaction. Only append the
 * actual new bars; old remnants and reservations retain identities and versions. */
export async function applyMaterialBarReceiptTx(tx: Db, plan: MaterialBarReceiptPlan, actor: number) {
  const current = await readMaterialBarInventoryTx(tx, plan.current.batch.id);
  const movement = (await tx.query<{ valid: boolean }>(`SELECT true AS valid FROM public.stock_movements
    WHERE id=$1::uuid AND stock_batch_id=$2::uuid AND status='POSTED' AND movement_type='IN' AND qty=$3`,
  [plan.movementId, current.batch.id, plan.quantityMm])).rows[0];
  if (!movement?.valid || BigInt(current.batch.movementCount) !== BigInt(plan.current.batch.movementCount) + 1n
    || Math.round(current.batch.physicalMm * 1000) !== Math.round(plan.current.batch.physicalMm * 1000) + Math.round(plan.quantityMm * 1000)
    || current.revision !== plan.current.revision || current.batch.reservedMm !== plan.current.batch.reservedMm
    || JSON.stringify([current.bars, current.holds, current.reservations]) !== JSON.stringify([plan.current.bars, plan.current.holds, plan.current.reservations]))
    throw new HttpError(409, 'MATERIAL_BAR_RECEIPT_CHANGED', 'Le stock a changé pendant cette réception. Actualisez avant de confirmer.');
  await tx.query(`INSERT INTO public.stock_material_bar_inventories(stock_batch_id,movement_count,confirmed_by,note)
    VALUES($1::uuid,$2::bigint,$3,'Barres confirmées à la réception') ON CONFLICT(stock_batch_id) DO UPDATE
    SET movement_count=excluded.movement_count,row_version=stock_material_bar_inventories.row_version+1,
      confirmed_at=now(),confirmed_by=excluded.confirmed_by,note=excluded.note`, [current.batch.id,current.batch.movementCount,actor]);
  for (const length of plan.lengths) {
    const barId = randomUUID();
    await tx.query(`INSERT INTO public.stock_material_bars(id,stock_batch_id,initial_length_mm,remaining_length_mm,created_by,updated_by)
      VALUES($1::uuid,$2::uuid,$3,$3,$4,$4)`, [barId,current.batch.id,length,actor]);
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'INITIALIZE',$2::uuid,NULL,$3::jsonb,'Barre reçue et contrôlée',$4)`,
    [barId,plan.movementId,JSON.stringify({ id:barId,batchId:current.batch.id,lengthMm:length,version:1,holds:[],source:'RECEIPT' }),actor]);
  }
  const result = await readMaterialBarInventoryTx(tx, current.batch.id);
  if (result.status !== 'CONFIRMED') throw new HttpError(409, 'MATERIAL_BAR_RECEIPT_CHANGED', result.warning ?? 'Les barres reçues ne correspondent pas à l’entrée en stock.');
  return result;
}
