import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { readMaterialBarInventoryTx, type MaterialBarInventory } from './material-bar-inventory.repository';
type Db = Pick<PoolClient, 'query'>;
export type BarAllocation = { barId: string; quantityMm: number; expectedVersion: number };

async function installed(tx: Db) {
  return (await tx.query<{ installed: boolean }>("SELECT to_regclass('public.stock_material_bar_reservations') IS NOT NULL AS installed")).rows[0]?.installed === true;
}
/** Called under the canonical lot/stock locks, before its counters are changed. */
export async function readTrackedMaterialBarInventoryTx(tx: Db, batchId: string | null) {
  if (!batchId || !await installed(tx)) return null;
  if (!(await tx.query('SELECT stock_batch_id FROM public.stock_material_bar_inventories WHERE stock_batch_id=$1::uuid', [batchId])).rows.length) return null;
  const current = await readMaterialBarInventoryTx(tx, batchId);
  if (current.status !== 'CONFIRMED')
    throw new HttpError(409, 'MATERIAL_BAR_REVIEW_REQUIRED', current.warning ?? 'Vérifiez les barres avant de réserver ce lot.');
  return current;
}

/** Generic stock reservations can select measured lengths directly. OF whole-
 * blank proposals supply their explicit per-bar allocations through this path. */
export function planMaterialBarReservation(current: MaterialBarInventory | null, quantityMm: number, selected?: readonly BarAllocation[]): BarAllocation[] {
  if (!current) {
    if (selected) throw new HttpError(409, 'MATERIAL_BAR_REVIEW_REQUIRED', 'Confirmez les barres du lot avant de les sélectionner.');
    return [];
  }
  const quantity = Math.round(quantityMm * 1000);
  if (!Number.isFinite(quantityMm) || quantityMm <= 0 || quantityMm > 1e9 || Math.abs(quantityMm * 1000 - quantity) > 1e-6)
    throw new HttpError(422, 'MATERIAL_BAR_LENGTH_INVALID', 'La longueur doit être positive, avec trois décimales maximum.');
  const free = new Map(current.bars.map(bar => [bar.id, Math.round(bar.lengthMm * 1000) - current.holds.filter(h => h.barId === bar.id).reduce((sum,h) => sum + Math.round(h.remainingMm * 1000),0)]));
  let plan = selected ? [...selected] : [];
  if (!selected) {
    let missing = quantity;
    for (const bar of current.bars) {
      const take = Math.min(missing, Math.max(0, free.get(bar.id) ?? 0));
      if (take > 0) plan.push({ barId: bar.id, quantityMm: take / 1000, expectedVersion: bar.version });
      missing -= take;
      if (!missing) break;
    }
  }
  let total = 0;
  const seen = new Set<string>();
  for (const item of plan) {
    const bar = current.bars.find(b => b.id === item.barId), length = Math.round(item.quantityMm * 1000);
    if (!bar || seen.has(item.barId) || bar.version !== item.expectedVersion || !Number.isFinite(item.quantityMm)
      || length <= 0 || Math.abs(item.quantityMm * 1000 - length) > 1e-6 || length > (free.get(item.barId) ?? 0))
      throw new HttpError(409, 'MATERIAL_BAR_ALLOCATION_CHANGED', 'Une barre sélectionnée a changé ou ne dispose pas de la longueur demandée.');
    seen.add(item.barId); total += length;
  }
  if (total !== quantity)
    throw new HttpError(409, 'MATERIAL_BAR_ALLOCATION_INCOMPLETE', 'La sélection des barres doit couvrir exactement la longueur réservée.');
  return plan;
}

/** Joins the canonical creation transaction after the reservation row is inserted.
 * A failed geometry update rolls back stock counters and its reservation together. */
export async function allocateMaterialBarReservationTx(tx: Db, current: MaterialBarInventory, plan: readonly BarAllocation[], input: { reservationId: string; actor: number; commandKey: string; reason: string }) {
  for (const item of plan) {
    const changed = await tx.query(`UPDATE public.stock_material_bars SET row_version=row_version+1,updated_at=now(),updated_by=$3
      WHERE id=$1::uuid AND stock_batch_id=$4::uuid AND row_version=$2 AND retired_at IS NULL RETURNING id`, [item.barId,item.expectedVersion,input.actor,current.batch.id]);
    if (!changed.rows.length) throw new HttpError(409, 'MATERIAL_BAR_ALLOCATION_CHANGED', 'Une barre a changé avant sa réservation.');
    await tx.query(`INSERT INTO public.stock_material_bar_reservations(bar_id,reservation_id,remaining_length_mm,updated_by)
      VALUES($1::uuid,$2::uuid,$3,$4)`, [item.barId,input.reservationId,item.quantityMm,input.actor]);
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'RESERVE',$3::jsonb,$4::jsonb,$5,$6)`, [item.barId,input.commandKey,
      JSON.stringify({ version:item.expectedVersion, holds:current.holds.filter(h=>h.barId===item.barId) }),
      JSON.stringify({ version:item.expectedVersion+1, reservationId:input.reservationId, reservedMm:item.quantityMm }),input.reason,input.actor]);
  }
  await tx.query('UPDATE public.stock_material_bar_inventories SET row_version=row_version+1 WHERE stock_batch_id=$1::uuid', [current.batch.id]);
  const result = await readMaterialBarInventoryTx(tx, current.batch.id);
  if (result.status !== 'CONFIRMED')
    throw new HttpError(409, 'MATERIAL_BAR_ALLOCATION_INCOMPLETE', result.warning ?? 'La réservation ne correspond pas aux barres.');
}

/** Canonical reservation is already released. Lengths remain on their original
 * bars; only the allocation is removed. No stock movement is manufactured. */
export async function releaseMaterialBarReservationTx(tx: Db, input: { reservationId: string; actor: number; commandKey: string; reason: string }) {
  if (!await installed(tx)) return;
  const holds = (await tx.query<{ barId: string; batchId: string; quantityMm: number; version: number }>(`SELECT b.id::text AS "barId",b.stock_batch_id::text AS "batchId",h.remaining_length_mm::float8 AS "quantityMm",b.row_version AS version
    FROM public.stock_material_bar_reservations h JOIN public.stock_material_bars b ON b.id=h.bar_id
    WHERE h.reservation_id=$1::uuid AND h.remaining_length_mm>0 ORDER BY b.id FOR UPDATE OF b`, [input.reservationId])).rows;
  if (!holds.length) return;
  const active = (await tx.query(`SELECT id FROM public.stock_reservations WHERE id=$1::uuid AND status='ACTIVE' AND qty_reserved>qty_consumed`, [input.reservationId])).rows.length;
  if (active) throw new HttpError(409, 'MATERIAL_BAR_RESERVATION_STILL_ACTIVE', 'Libérez la réservation avant de retirer son affectation aux barres.');
  for (const hold of holds) {
    await tx.query('UPDATE public.stock_material_bar_reservations SET remaining_length_mm=0,updated_at=now(),updated_by=$3 WHERE bar_id=$1::uuid AND reservation_id=$2::uuid', [hold.barId,input.reservationId,input.actor]);
    await tx.query('UPDATE public.stock_material_bars SET row_version=row_version+1,updated_at=now(),updated_by=$2 WHERE id=$1::uuid', [hold.barId,input.actor]);
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'RELEASE',$3::jsonb,$4::jsonb,$5,$6)`, [hold.barId,input.commandKey,
      JSON.stringify({ version:hold.version, reservationId:input.reservationId, reservedMm:hold.quantityMm }),
      JSON.stringify({ version:hold.version+1, reservationId:input.reservationId, reservedMm:0 }),input.reason,input.actor]);
  }
  for (const batchId of new Set(holds.map(h=>h.batchId)))
    await tx.query('UPDATE public.stock_material_bar_inventories SET row_version=row_version+1 WHERE stock_batch_id=$1::uuid', [batchId]);
}

export async function reservationHasPhysicalBarsTx(tx: Db, reservationId: string) {
  return await installed(tx) && (await tx.query('SELECT 1 FROM public.stock_material_bar_reservations WHERE reservation_id=$1::uuid AND remaining_length_mm>0 LIMIT 1', [reservationId])).rows.length > 0;
}
