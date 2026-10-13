import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { planMaterialBarQuality } from '../domain/material-bar-quality';
import type { MaterialBarQualityCommand } from '../domain/material-bar-movement';
import { lockMaterialBarInventoryTx, readMaterialBarInventoryTx, type MaterialBarInventory } from './material-bar-inventory.repository';

type Db = Pick<PoolClient, 'query'>;
type Movement = { id: string; batchId: string; articleId: string; type: string; quantity: number; status: string; reversalOf: string | null };
export type PreparedMaterialBarQuality = Readonly<{ kind: 'QUALITY' }>;
const prepared = new WeakMap<PreparedMaterialBarQuality, { tx: Db; source: MaterialBarInventory; movement: Movement; plan: ReturnType<typeof planMaterialBarQuality> }>();
const milli = (value: number) => Math.round(value * 1000);
function changed(message: string): never { throw new HttpError(409, 'MATERIAL_BAR_QUALITY_CHANGED', message); }
async function movementTx(tx: Db, id: string) {
  const movement = (await tx.query<Movement>(`SELECT id::text,stock_batch_id::text AS "batchId",article_id::text AS "articleId",
    movement_type::text AS type,qty::float8 AS quantity,status,reversal_of_id::text AS "reversalOf"
    FROM public.stock_movements WHERE id=$1::uuid FOR UPDATE`, [id])).rows[0];
  if (!movement) changed('Le mouvement de la décision qualité est introuvable.');
  return movement;
}

/** Called after canonical lot/reservation locks, before posting the ledger. */
export async function prepareMaterialBarQualityTx(tx: Db, input: { movementId: string; batchId: string; command: MaterialBarQualityCommand }) {
  const movement = await movementTx(tx, input.movementId);
  if (movement.status !== 'DRAFT' || !['DEPRECIATE', 'SCRAP'].includes(movement.type) || movement.reversalOf
    || movement.quantity <= 0 || movement.batchId !== input.batchId)
    changed('La sélection des barres ne correspond pas à la décision qualité en brouillon.');
  const source = await lockMaterialBarInventoryTx(tx, input.batchId);
  if (source.batch.articleId !== movement.articleId) changed('La décision qualité concerne un autre article.');
  const plan = planMaterialBarQuality(source, movement.quantity, input.command);
  const token = Object.freeze({ kind: 'QUALITY' as const });
  prepared.set(token, { tx, source, movement, plan });
  return token;
}

/** An opaque one-use capability binds the physical update to the actual posted
 * decision. Any mismatch rolls back the caller's complete transaction. */
export async function applyMaterialBarQualityTx(tx: Db, token: PreparedMaterialBarQuality, actor: number) {
  const entry = prepared.get(token);
  if (!entry || entry.tx !== tx) changed('Préparez les barres dans la transaction de cette décision qualité.');
  const { source, movement, plan } = entry;
  const posted = await movementTx(tx, movement.id), current = await readMaterialBarInventoryTx(tx, source.batch.id);
  if (posted.status !== 'POSTED' || posted.type !== movement.type || posted.quantity !== movement.quantity
    || posted.batchId !== movement.batchId || posted.articleId !== movement.articleId || posted.reversalOf
    || current.revision !== source.revision || milli(current.batch.physicalMm) !== milli(source.batch.physicalMm)
    || milli(current.batch.depreciatedMm ?? 0) !== milli(source.batch.depreciatedMm ?? 0) + milli(plan.quantityMm)
    || BigInt(current.batch.movementCount) !== BigInt(source.batch.movementCount) + 1n
    || JSON.stringify([current.bars, current.holds, current.reservations]) !== JSON.stringify([source.bars, source.holds, source.reservations]))
    changed('Le stock ou les réservations ont changé pendant la décision qualité. Aucune modification n’est conservée.');
  for (const change of plan.changes) {
    const updated = await tx.query(`UPDATE public.stock_material_bars SET depreciated_length_mm=$3,row_version=row_version+1,
      updated_at=now(),updated_by=$4 WHERE id=$1::uuid AND row_version=$2 AND stock_batch_id=$5::uuid AND retired_at IS NULL RETURNING id`,
    [change.bar.id, change.bar.version, change.depreciatedMm, actor, source.batch.id]);
    if (updated.rows.length !== 1) changed('Une barre a changé pendant la décision qualité.');
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'DEPRECIATE',$2::uuid,$3::jsonb,$4::jsonb,'Longueur dépréciée par décision qualité',$5)`,
    [change.bar.id, movement.id, JSON.stringify(change.bar), JSON.stringify({ ...change.bar, depreciatedMm: change.depreciatedMm,
      version: change.nextVersion, source: 'STOCK_QUALITY' }), actor]);
  }
  await tx.query(`UPDATE public.stock_material_bar_inventories SET movement_count=$2::bigint,row_version=row_version+1,
    confirmed_at=now(),confirmed_by=$3,note='Décision qualité affectée aux barres' WHERE stock_batch_id=$1::uuid`,
  [source.batch.id, current.batch.movementCount, actor]);
  const result = await readMaterialBarInventoryTx(tx, source.batch.id);
  if (result.status !== 'CONFIRMED') changed(result.warning ?? 'La décision qualité ne correspond pas aux barres.');
  prepared.delete(token);
  return result;
}
