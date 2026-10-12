import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { HttpError } from '../../../utils/httpError';
import { reconcileMaterialBars, type MaterialBar, type MaterialBarHold } from '../domain/material-bars';
import type { MaterialBarInventoryCommand } from '../validators/material-bars.validators';

type Db = Pick<PoolClient, 'query'>;
export type MaterialBarBatch = {
  id: string; levelId: string; lotId: string; lotCode: string;
  articleId: string; articleCode: string; designation: string; unit: string;
  physicalMm: number; reservedMm: number; depreciatedMm?: number; movementCount: string;
};
export type MaterialBarReservation = {
  id: string; batchId: string; remainingMm: number; version: number;
  ofId: number | null; ofNumber: string | null;
};
export type MaterialBarRecord = MaterialBar & { initialLengthMm: number; createdAt: string };
export type MaterialBarInventory = {
  batch: MaterialBarBatch;
  bars: MaterialBarRecord[];
  holds: MaterialBarHold[];
  reservations: MaterialBarReservation[];
  revision: number;
  version: string;
  status: 'UNCONFIRMED' | 'REVIEW_REQUIRED' | 'CONFIRMED';
  warning: string | null;
};

export async function assertMaterialBarSchema(tx: Db): Promise<void> {
  const row = (await tx.query<{ installed: boolean }>(`SELECT
    to_regclass('public.stock_material_bar_inventories') IS NOT NULL
    AND to_regclass('public.stock_material_bars') IS NOT NULL
    AND to_regclass('public.stock_material_bar_reservations') IS NOT NULL
    AND to_regclass('public.stock_material_bar_events') IS NOT NULL
    AND to_regprocedure('public.check_material_bar_quality_1246()') IS NOT NULL AS installed`)).rows[0];
  if (!row?.installed) throw new HttpError(409, 'MATERIAL_BARS_NOT_INSTALLED', 'Le suivi des barres nécessite la mise à jour du stock.');
}

/** Call in a consistent read transaction, or with canonical stock locked for a write.
 * POSTED movement count also detects OUT+IN pairs whose net length is unchanged. */
export async function readMaterialBarInventoryTx(tx: Db, batchId: string): Promise<MaterialBarInventory> {
  const batch = (await tx.query<MaterialBarBatch>(`SELECT b.id::text,b.stock_level_id::text AS "levelId",
    b.lot_id::text AS "lotId",l.lot_code AS "lotCode",a.id::text AS "articleId",a.code AS "articleCode",
    a.designation,lower(trim(a.unite)) AS unit,b.qty_total::float8 AS "physicalMm",b.qty_reserved::float8 AS "reservedMm",b.qty_depreciated::float8 AS "depreciatedMm",
    (SELECT count(*)::text FROM public.stock_movements m WHERE m.stock_batch_id=b.id AND m.status='POSTED') AS "movementCount"
    FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id
    JOIN public.lots l ON l.id=b.lot_id JOIN public.articles a ON a.id=s.article_id AND a.id=l.article_id
    WHERE b.id=$1::uuid`, [batchId])).rows[0];
  if (!batch) throw new HttpError(404, 'STOCK_BATCH_NOT_FOUND', 'Lot de stock introuvable.');
  if (batch.unit !== 'mm') throw new HttpError(422, 'MATERIAL_BAR_UNIT_REQUIRED', 'Le suivi des barres concerne les matières gérées en millimètres.');
  const inventory = (await tx.query<{ revision: number; movementCount: string }>(`SELECT row_version AS revision,movement_count::text AS "movementCount"
    FROM public.stock_material_bar_inventories WHERE stock_batch_id=$1::uuid`, [batchId])).rows[0];
  const bars = (await tx.query<MaterialBarRecord>(`SELECT id::text,stock_batch_id::text AS "batchId",
    remaining_length_mm::float8 AS "lengthMm",depreciated_length_mm::float8 AS "depreciatedMm",initial_length_mm::float8 AS "initialLengthMm",row_version AS version,created_at::text AS "createdAt"
    FROM public.stock_material_bars WHERE stock_batch_id=$1::uuid AND retired_at IS NULL ORDER BY created_at,id`, [batchId])).rows;
  const reservations = (await tx.query<MaterialBarReservation>(`SELECT r.id::text,r.stock_batch_id::text AS "batchId",
    greatest(0,r.qty_reserved-r.qty_consumed)::float8 AS "remainingMm",r.row_version AS version,r.of_id AS "ofId",o.numero AS "ofNumber"
    FROM public.stock_reservations r LEFT JOIN public.ordres_fabrication o ON o.id=r.of_id
    WHERE r.stock_batch_id=$1::uuid AND r.status='ACTIVE' AND r.qty_reserved>r.qty_consumed ORDER BY r.id`, [batchId])).rows;
  const holds = (await tx.query<MaterialBarHold>(`SELECT h.bar_id::text AS "barId",h.reservation_id::text AS "reservationId",h.remaining_length_mm::float8 AS "remainingMm"
    FROM public.stock_material_bar_reservations h JOIN public.stock_material_bars b ON b.id=h.bar_id
    WHERE b.stock_batch_id=$1::uuid AND h.remaining_length_mm>0 ORDER BY h.bar_id,h.reservation_id`, [batchId])).rows;
  let status: MaterialBarInventory['status'] = inventory ? 'CONFIRMED' : 'UNCONFIRMED';
  let warning: string | null = inventory ? null : 'Confirmez les barres présentes dans ce lot.';
  if (inventory) {
    try {
      if (inventory.movementCount !== batch.movementCount)
        throw new HttpError(409, 'MATERIAL_BAR_INVENTORY_CHANGED', 'Un mouvement de stock impose de vérifier les barres restantes.');
      reconcileMaterialBars({ bars, holds, batches: [batch], reservations });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      status = 'REVIEW_REQUIRED'; warning = error.message;
    }
  }
  const revision = inventory?.revision ?? 0;
  const version = createHash('sha256').update(JSON.stringify({ batch, revision, inventoryMovementCount: inventory?.movementCount ?? null, bars, reservations, holds })).digest('hex');
  return { batch, bars, holds, reservations, revision, version, status, warning };
}

/** Existing release/debit commands lock reservations before stock balances.
 * Take the lot first (same order as quality), then reservations and stock, so an
 * inventory cannot deadlock a release holding its reservation row. All physical
 * bar mutations must use this lock boundary after any planning/OF locks. */
export async function lockMaterialBarInventoryTx(tx: Db, batchId: string): Promise<MaterialBarInventory> {
  const identity = (await tx.query<{ levelId: string; lotId: string }>(`SELECT stock_level_id::text AS "levelId",lot_id::text AS "lotId"
    FROM public.stock_batches WHERE id=$1::uuid`, [batchId])).rows[0];
  if (!identity) throw new HttpError(404, 'STOCK_BATCH_NOT_FOUND', 'Lot de stock introuvable.');
  await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE', [identity.lotId]);
  await tx.query('SELECT id FROM public.stock_reservations WHERE stock_batch_id=$1::uuid ORDER BY id FOR UPDATE', [batchId]);
  await tx.query('SELECT id FROM public.stock_levels WHERE id=$1::uuid FOR UPDATE', [identity.levelId]);
  await tx.query('SELECT id FROM public.stock_batches WHERE id=$1::uuid FOR UPDATE', [batchId]);
  await tx.query('SELECT stock_batch_id FROM public.stock_material_bar_inventories WHERE stock_batch_id=$1::uuid FOR UPDATE', [batchId]);
  await tx.query('SELECT id FROM public.stock_material_bars WHERE stock_batch_id=$1::uuid ORDER BY id FOR UPDATE', [batchId]);
  const current = await readMaterialBarInventoryTx(tx, batchId);
  if (current.batch.levelId !== identity.levelId || current.batch.lotId !== identity.lotId)
    throw new HttpError(409, 'STOCK_BATCH_CHANGED', 'L’emplacement de ce lot a changé. Actualisez les barres.');
  return current;
}

export function proposedBarInventory(current: MaterialBarInventory, body: MaterialBarInventoryCommand) {
  if (body.expectedVersion !== current.version)
    throw new HttpError(409, 'MATERIAL_BAR_INVENTORY_CHANGED', 'Le stock ou ses réservations ont changé. Actualisez avant de confirmer.');
  const bars = body.bars.map(bar => {
    const previous = current.bars.find(item => item.id === bar.id);
    if (previous && bar.lengthMm > previous.initialLengthMm)
      throw new HttpError(422, 'MATERIAL_BAR_RECONCILIATION_REQUIRED', 'Une longueur supérieure à la barre initiale nécessite une nouvelle identité de barre.');
    return { id: bar.id, batchId: current.batch.id, lengthMm: bar.lengthMm, depreciatedMm: bar.depreciatedMm ?? 0, version: (previous?.version ?? 0) + 1 };
  });
  const holds = body.bars.flatMap(bar => bar.allocations.map(a => ({ barId: bar.id, reservationId: a.reservationId, remainingMm: a.quantityMm })));
  reconcileMaterialBars({ bars, holds, batches: [current.batch], reservations: current.reservations });
  return { bars, holds };
}

/** Writes geometry only; the measured sum and each allocation must already equal
 * canonical stock. Called by a command transaction after lockMaterialBarInventoryTx. */
export async function writeMaterialBarInventoryTx(tx: Db, current: MaterialBarInventory, body: MaterialBarInventoryCommand, actor: number, commandKey: string) {
  const proposed = proposedBarInventory(current, body);
  const newIds = proposed.bars.filter(bar => !current.bars.some(old => old.id === bar.id)).map(bar => bar.id);
  if (newIds.length && (await tx.query('SELECT id FROM public.stock_material_bars WHERE id=ANY($1::uuid[])', [newIds])).rows.length)
    throw new HttpError(409, 'MATERIAL_BAR_IDENTITY_USED', 'Une identité de barre est déjà utilisée. Actualisez le comptage.');
  await tx.query(`INSERT INTO public.stock_material_bar_inventories(stock_batch_id,movement_count,row_version,confirmed_by,note)
    VALUES($1::uuid,$2::bigint,1,$3,$4) ON CONFLICT(stock_batch_id) DO UPDATE
    SET movement_count=excluded.movement_count,row_version=stock_material_bar_inventories.row_version+1,
      confirmed_at=now(),confirmed_by=excluded.confirmed_by,note=excluded.note`, [current.batch.id,current.batch.movementCount,actor,body.reason]);
  await tx.query(`UPDATE public.stock_material_bar_reservations h SET remaining_length_mm=0,updated_at=now(),updated_by=$2
    FROM public.stock_material_bars b WHERE b.id=h.bar_id AND b.stock_batch_id=$1::uuid AND h.remaining_length_mm<>0`, [current.batch.id,actor]);
  for (const old of current.bars) {
    if (proposed.bars.some(bar => bar.id === old.id)) continue;
    await tx.query('UPDATE public.stock_material_bars SET retired_at=now(),row_version=row_version+1,updated_at=now(),updated_by=$2 WHERE id=$1::uuid', [old.id,actor]);
    await recordBarInventoryEventTx(tx, { id: old.id, commandKey, action: 'RECONCILE', before: { ...old, holds: current.holds.filter(h => h.barId === old.id) }, after: { retired: true }, actor, reason: body.reason });
  }
  for (const bar of proposed.bars) {
    const old = current.bars.find(item => item.id === bar.id);
    if (old) await tx.query(`UPDATE public.stock_material_bars SET remaining_length_mm=$2,row_version=$3,updated_at=now(),updated_by=$4,depreciated_length_mm=$5 WHERE id=$1::uuid`, [bar.id,bar.lengthMm,bar.version,actor,bar.depreciatedMm]);
    else {
      const inserted = await tx.query(`INSERT INTO public.stock_material_bars(id,stock_batch_id,initial_length_mm,remaining_length_mm,created_by,updated_by,depreciated_length_mm)
        VALUES($1::uuid,$2::uuid,$3,$3,$4,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id`, [bar.id,bar.batchId,bar.lengthMm,actor,bar.depreciatedMm]);
      if (!inserted.rows.length) throw new HttpError(409, 'MATERIAL_BAR_IDENTITY_USED', 'Une identité de barre est déjà utilisée. Actualisez le comptage.');
    }
    const holds = proposed.holds.filter(h => h.barId === bar.id);
    for (const hold of holds) await tx.query(`INSERT INTO public.stock_material_bar_reservations(bar_id,reservation_id,remaining_length_mm,updated_by)
      VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(bar_id,reservation_id) DO UPDATE
      SET remaining_length_mm=excluded.remaining_length_mm,updated_at=now(),updated_by=excluded.updated_by`, [bar.id,hold.reservationId,hold.remainingMm,actor]);
    await recordBarInventoryEventTx(tx, { id: bar.id, commandKey, action: old ? 'RECONCILE' : 'INITIALIZE', before: old ? { ...old, holds: current.holds.filter(h => h.barId === old.id) } : null, after: { ...bar, holds }, actor, reason: body.reason });
  }
  return readMaterialBarInventoryTx(tx, current.batch.id);
}

async function recordBarInventoryEventTx(tx: Db, event: { id: string; commandKey: string; action: string; before: unknown; after: unknown; actor: number; reason: string }) {
  await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,before_state,after_state,reason,created_by)
    VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb,$6,$7)`, [event.id,event.commandKey,event.action,JSON.stringify(event.before),JSON.stringify(event.after),event.reason,event.actor]);
}
