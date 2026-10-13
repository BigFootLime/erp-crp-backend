import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../../utils/httpError';
import { planMaterialBarMovement, type MaterialBarMovementCommand, type MaterialBarMovementPlan } from '../domain/material-bar-movement';
import { lockMaterialBarInventoryTx, readMaterialBarInventoryTx, type MaterialBarInventory } from './material-bar-inventory.repository';
import { lockMaterialBarReceiptLotTx } from './material-bar-receipt.repository';

type Db = Pick<PoolClient, 'query'>;
type LedgerMovement = { id: string; batchId: string | null; articleId: string; quantity: number; status: string; type: string };
export type PreparedMaterialBarMovement = {
  movement: LedgerMovement;
  source: MaterialBarInventory;
  destination?: MaterialBarInventory;
  plan: MaterialBarMovementPlan;
};
const preparedTransactions = new WeakMap<PreparedMaterialBarMovement, Db>();
function changed(message: string): never { throw new HttpError(409, 'MATERIAL_BAR_MOVEMENT_CHANGED', message); }
const milli = (value: number) => Math.round(value * 1000);

async function readMovement(tx: Db, id: string) {
  const row = (await tx.query<LedgerMovement>(`SELECT id::text,stock_batch_id::text AS "batchId",article_id::text AS "articleId",
    qty::float8 AS quantity,status,movement_type::text AS type FROM public.stock_movements WHERE id=$1::uuid FOR UPDATE`, [id])).rows[0];
  if (!row) changed('Le mouvement de stock est introuvable.');
  return row;
}

function matchingKind(movement: LedgerMovement, kind: MaterialBarMovementCommand['kind']) {
  if (kind === 'DEPRECIATE') return false;
  if (!Number.isFinite(movement.quantity) || movement.quantity === 0) return false;
  if (kind === 'TRANSFER') return movement.type === 'TRANSFER' && movement.quantity > 0;
  if (kind === 'RECEIVE') return movement.quantity > 0 && ['IN', 'ADJUST', 'ADJUSTMENT'].includes(movement.type);
  // SCRAP and DEPRECIATE keep qty_total in the canonical ledger. They require
  // a quality allocation, never a physical length subtraction through ISSUE.
  return (movement.quantity > 0 && movement.type === 'OUT')
    || (movement.quantity < 0 && ['ADJUST', 'ADJUSTMENT'].includes(movement.type));
}

/** The caller owns the canonical stock transaction and locks its movement first.
 * Lot/reservation locks precede stock locks. A transfer destination batch must
 * already exist (it may be empty); resolving/creating it uses the same lot lock.
 * This prepares geometry only: it neither posts nor authorizes a stock movement. */
export async function prepareMaterialBarMovementTx(tx: Db, input: {
  movementId: string; sourceBatchId: string; destinationBatchId?: string; command: MaterialBarMovementCommand;
}): Promise<PreparedMaterialBarMovement> {
  const movement = await readMovement(tx, input.movementId);
  if (movement.status !== 'DRAFT' || !matchingKind(movement, input.command.kind) || movement.batchId !== input.sourceBatchId)
    changed('Les barres sélectionnées ne correspondent pas au mouvement en brouillon.');
  const batches = [...new Set([input.sourceBatchId, input.destinationBatchId].filter((id): id is string => !!id))].sort();
  const identities = (await tx.query<{ id: string; lotId: string; articleId: string }>(`SELECT b.id::text,b.lot_id::text AS "lotId",s.article_id::text AS "articleId"
    FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id WHERE b.id=ANY($1::uuid[]) ORDER BY b.id`, [batches])).rows;
  if (identities.length !== batches.length || identities.some(b => b.articleId !== movement.articleId)
    || new Set(identities.map(b => b.lotId)).size !== 1)
    changed('Le mouvement doit conserver le même article et le même lot matière.');
  await lockMaterialBarReceiptLotTx(tx, identities[0].lotId);
  const inventories = new Map<string, MaterialBarInventory>();
  for (const batchId of batches) inventories.set(batchId, await lockMaterialBarInventoryTx(tx, batchId));
  const source = inventories.get(input.sourceBatchId)!;
  const destination = input.destinationBatchId ? inventories.get(input.destinationBatchId) : undefined;
  if ((input.command.kind === 'TRANSFER') !== !!destination)
    changed('Seul un transfert de barres doit comporter un emplacement de destination.');
  const plan = planMaterialBarMovement({ source, destination, quantityMm: Math.abs(movement.quantity), command: input.command });
  const result = { movement, source, destination, plan };
  preparedTransactions.set(result, tx);
  return result;
}

function sameGeometry(before: MaterialBarInventory, after: MaterialBarInventory) {
  return before.revision === after.revision && before.batch.reservedMm === after.batch.reservedMm
    && JSON.stringify([before.bars, before.holds, before.reservations]) === JSON.stringify([after.bars, after.holds, after.reservations]);
}

/** Called after canonical posting, before COMMIT. Neither a net balance alone
 * nor a caller-supplied list of leg IDs is proof: verify the actual posted ledger,
 * its movement watermark and the still-locked physical snapshot. */
export async function applyMaterialBarMovementTx(tx: Db, prepared: PreparedMaterialBarMovement, actor: number) {
  if (preparedTransactions.get(prepared) !== tx) changed('Préparez les barres dans la transaction de ce mouvement.');
  const { plan, source, destination } = prepared;
  const movement = await readMovement(tx, prepared.movement.id);
  if (movement.status !== 'POSTED' || !matchingKind(movement, plan.kind)
    || movement.batchId !== source.batch.id || movement.articleId !== source.batch.articleId || movement.quantity !== prepared.movement.quantity)
    changed('Le mouvement comptabilisé ne correspond pas aux barres préparées.');
  let ledger = [movement];
  if (plan.kind === 'TRANSFER') {
    const legs = (await tx.query<LedgerMovement>(`SELECT id::text,stock_batch_id::text AS "batchId",article_id::text AS "articleId",
      qty::float8 AS quantity,status,movement_type::text AS type FROM public.stock_movements
      WHERE doc_type='STOCK_TRANSFER_INTERNAL' AND doc_id=$1::uuid ORDER BY id FOR UPDATE`, [movement.id])).rows;
    if (legs.length !== 2 || !destination || !legs.some(m => m.type === 'OUT' && m.batchId === source.batch.id)
      || !legs.some(m => m.type === 'IN' && m.batchId === destination.batch.id)
      || legs.some(m => m.status !== 'POSTED' || m.articleId !== movement.articleId || m.quantity !== movement.quantity))
      changed('Les deux mouvements du transfert doivent correspondre exactement aux barres déplacées.');
    ledger = [...ledger, ...legs];
  }
  const snapshots = destination ? [source, destination] : [source];
  for (const before of snapshots) {
    const current = await readMaterialBarInventoryTx(tx, before.batch.id);
    const delta = plan.kind === 'RECEIVE' || before === destination ? plan.quantityMm : -plan.quantityMm;
    const postedCount = ledger.filter(m => m.batchId === before.batch.id).length;
    if (!sameGeometry(before, current) || milli(current.batch.depreciatedMm ?? 0) !== milli(before.batch.depreciatedMm ?? 0) || milli(current.batch.physicalMm) !== milli(before.batch.physicalMm) + milli(delta)
      || BigInt(current.batch.movementCount) !== BigInt(before.batch.movementCount) + BigInt(postedCount))
      changed('Le stock ou les réservations ont changé pendant le mouvement. Aucune modification n’est conservée.');
    await tx.query(`INSERT INTO public.stock_material_bar_inventories(stock_batch_id,movement_count,confirmed_by,note)
      VALUES($1::uuid,$2::bigint,$3,'Mouvement des barres confirmé') ON CONFLICT(stock_batch_id) DO UPDATE
      SET movement_count=excluded.movement_count,row_version=stock_material_bar_inventories.row_version+1,
        confirmed_at=now(),confirmed_by=excluded.confirmed_by,note=excluded.note`, [current.batch.id,current.batch.movementCount,actor]);
  }
  async function event(barId: string, action: string, before: unknown, after: unknown) {
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,$3,$2::uuid,$4::jsonb,$5::jsonb,'Mouvement de stock des barres',$6)`,
    [barId,movement.id,action,before === null ? null : JSON.stringify(before),JSON.stringify(after),actor]);
  }
  if (plan.kind === 'RECEIVE') {
    for (const lengthMm of plan.lengths) {
      const id = randomUUID();
      await tx.query(`INSERT INTO public.stock_material_bars(id,stock_batch_id,initial_length_mm,remaining_length_mm,created_by,updated_by)
        VALUES($1::uuid,$2::uuid,$3,$3,$4,$4)`, [id,source.batch.id,lengthMm,actor]);
      await event(id, 'INITIALIZE', null, { id, batchId: source.batch.id, lengthMm, version: 1, source: 'STOCK_MOVEMENT' });
    }
  } else if (plan.kind === 'ISSUE') {
    for (const change of plan.changes) {
      const updated = await tx.query(`UPDATE public.stock_material_bars SET remaining_length_mm=$3,row_version=row_version+1,updated_at=now(),updated_by=$4
        WHERE id=$1::uuid AND row_version=$2 AND stock_batch_id=$5::uuid AND retired_at IS NULL RETURNING id`,
      [change.bar.id,change.bar.version,change.remainingMm,actor,source.batch.id]);
      if (updated.rows.length !== 1) changed('La barre sélectionnée a changé pendant la sortie.');
      await event(change.bar.id, 'CUT', change.bar, { ...change.bar, lengthMm: change.remainingMm, version: change.nextVersion, source: 'STOCK_MOVEMENT' });
    }
  } else {
    // All immutable proofs precede the identity-preserving updates. The SQL
    // guard checks the complete transfer quantity and both canonical legs.
    for (const bar of plan.bars) await event(bar.id, 'MOVE', source.bars.find(b => b.id === bar.id), { ...bar, source: 'STOCK_MOVEMENT' });
    for (const bar of plan.bars) {
      const updated = await tx.query(`UPDATE public.stock_material_bars SET stock_batch_id=$3::uuid,row_version=row_version+1,updated_at=now(),updated_by=$4
        WHERE id=$1::uuid AND row_version=$2 AND stock_batch_id=$5::uuid AND retired_at IS NULL RETURNING id`,
      [bar.id,bar.version-1,destination!.batch.id,actor,source.batch.id]);
      if (updated.rows.length !== 1) changed('La barre sélectionnée a changé pendant le transfert.');
    }
  }
  const result: MaterialBarInventory[] = [];
  for (const before of snapshots) {
    const current = await readMaterialBarInventoryTx(tx, before.batch.id);
    if (current.status !== 'CONFIRMED') changed(current.warning ?? 'Le stock et les barres ne correspondent pas après le mouvement.');
    result.push(current);
  }
  preparedTransactions.delete(prepared);
  return result;
}
