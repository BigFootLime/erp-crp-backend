import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { planMaterialBarCompensation, type MaterialBarMovementProof } from '../domain/material-bar-compensation';
import { lockMaterialBarInventoryTx, readMaterialBarInventoryTx, type MaterialBarInventory } from './material-bar-inventory.repository';
import { prepareMaterialBarMovementTx, applyMaterialBarMovementTx, type PreparedMaterialBarMovement } from './material-bar-movement.repository';

type Db = Pick<PoolClient, 'query'>;
type Movement = { id: string; batchId: string | null; articleId: string; type: string; quantity: number; status: string; reversalOf: string | null };
type Compensation = { kind: 'COMPENSATION'; movement: Movement; originalId: string; source: MaterialBarInventory;
  plan: ReturnType<typeof planMaterialBarCompensation>; transfer?: PreparedMaterialBarMovement };
// Keep the authoritative plan private so a caller cannot mutate it after preparation.
export type PreparedMaterialBarCompensation = Readonly<{ kind: 'COMPENSATION' }>;
const prepared = new WeakMap<PreparedMaterialBarCompensation, { tx: Db; value: Compensation }>();
const milli = (value: number) => Math.round(value * 1000);
function changed(message: string): never { throw new HttpError(409, 'MATERIAL_BAR_COMPENSATION_CHANGED', message); }
async function readMovement(tx: Db, id: string): Promise<Movement> {
  const row = (await tx.query<Movement>(`SELECT id::text,stock_batch_id::text AS "batchId",article_id::text AS "articleId",
    movement_type::text AS type,qty::float8 AS quantity,status,reversal_of_id::text AS "reversalOf"
    FROM public.stock_movements WHERE id=$1::uuid FOR UPDATE`, [id])).rows[0];
  if (!row) changed('Le mouvement de stock est introuvable.');
  return row;
}

/** Read-only eligibility for the stock preview. The posting transaction repeats
 * every check under locks; displaying this result grants no posting authority. */
export async function previewMaterialBarCompensationTx(tx: Db, originalId: string): Promise<boolean | null> {
  const installed = (await tx.query<{ installed: boolean }>(`SELECT to_regclass('public.stock_material_bar_inventories') IS NOT NULL
    AND to_regclass('public.stock_material_bar_events') IS NOT NULL AS installed`)).rows[0]?.installed;
  if (!installed) return null;
  const original = (await tx.query<Movement>(`SELECT id::text,stock_batch_id::text AS "batchId",article_id::text AS "articleId",
    movement_type::text AS type,qty::float8 AS quantity,status,reversal_of_id::text AS "reversalOf"
    FROM public.stock_movements WHERE id=$1::uuid`, [originalId])).rows[0];
  if (!original?.batchId) return null;
  const proofs = (await tx.query<MaterialBarMovementProof>(`SELECT bar_id::text AS "barId",action,
    before_state AS before,after_state AS after FROM public.stock_material_bar_events WHERE stock_movement_id=$1::uuid ORDER BY bar_id`, [original.id])).rows;
  const tracked = (await tx.query(`SELECT 1 FROM public.stock_material_bar_inventories WHERE stock_batch_id=$1::uuid`, [original.batchId])).rows.length > 0;
  if (!tracked && !proofs.length) return null;
  if (original.status !== 'POSTED' || original.reversalOf) changed('Ce mouvement ne possède pas de compensation physique prise en charge.');
  let sourceBatchId = original.batchId;
  if (original.type === 'TRANSFER') {
    const destinations = (await tx.query<{ batchId: string }>(`SELECT stock_batch_id::text AS "batchId" FROM public.stock_movements
      WHERE doc_type='STOCK_TRANSFER_INTERNAL' AND doc_id=$1::uuid AND movement_type='IN' AND status='POSTED'`, [original.id])).rows;
    if (destinations.length !== 1 || !destinations[0].batchId) changed('Le transfert d’origine est incomplet.');
    sourceBatchId = destinations[0].batchId;
  }
  const source = await readMaterialBarInventoryTx(tx, sourceBatchId);
  const plan = planMaterialBarCompensation({ original: { ...original,batchId:original.batchId },source,
    destinationBatchId: original.type === 'TRANSFER' ? original.batchId : undefined,proofs });
  assertInitialLengths(source, plan);
  if (original.type === 'TRANSFER') {
    const destination = await readMaterialBarInventoryTx(tx, original.batchId);
    if (destination.status !== 'CONFIRMED') changed('Confirmez les barres de l’emplacement de retour avant de corriger ce transfert.');
  }
  return true;
}

function assertInitialLengths(source: MaterialBarInventory, plan: ReturnType<typeof planMaterialBarCompensation>) {
  for (const change of plan.changes) {
    const bar = source.bars.find(b => b.id === change.bar.id)!;
    if (change.restoredMm > bar.initialLengthMm || (plan.kind === 'RETIRE' && bar.lengthMm !== bar.initialLengthMm))
      changed('La longueur à restituer ne correspond pas à la barre d’origine.');
  }
}

/** The posting boundary has locked all affected lots/reservations first.
 * The inverse draft is server-generated; no bar selection is accepted here. */
export async function prepareMaterialBarCompensationTx(tx: Db, input: {
  movementId: string; destinationBatchId?: string;
}): Promise<PreparedMaterialBarCompensation> {
  const movement = await readMovement(tx, input.movementId);
  if (movement.status !== 'DRAFT' || !movement.reversalOf || !movement.batchId)
    changed('La compensation doit être un brouillon lié au mouvement d’origine.');
  const original = await readMovement(tx, movement.reversalOf);
  const expectedType = original.type === 'IN' ? 'OUT' : original.type === 'OUT' ? 'IN'
    : original.type === 'TRANSFER' ? 'TRANSFER' : ['ADJUST', 'ADJUSTMENT'].includes(original.type) ? 'ADJUSTMENT' : null;
  const expectedQuantity = expectedType === 'ADJUSTMENT' ? -original.quantity : original.quantity;
  if (original.status !== 'POSTED' || !original.batchId || original.reversalOf || !expectedType
    || movement.type !== expectedType || movement.quantity !== expectedQuantity || movement.articleId !== original.articleId)
    changed('Le brouillon ne correspond plus au mouvement d’origine.');
  const duplicates = (await tx.query(`SELECT id FROM public.stock_movements
    WHERE reversal_of_id=$1::uuid AND id<>$2::uuid AND status<>'CANCELLED' LIMIT 1`, [original.id,movement.id])).rows;
  if (duplicates.length) changed('Une autre compensation existe déjà pour ce mouvement.');
  const inventories = new Map<string, MaterialBarInventory>();
  for (const id of [...new Set([movement.batchId,input.destinationBatchId].filter((id): id is string => !!id))].sort())
    inventories.set(id, await lockMaterialBarInventoryTx(tx, id));
  const source = inventories.get(movement.batchId)!;
  if (source.batch.articleId !== original.articleId) changed('Le lot ne correspond pas à l’article du mouvement.');
  const proofs = (await tx.query<MaterialBarMovementProof>(`SELECT bar_id::text AS "barId",action,
    before_state AS before,after_state AS after FROM public.stock_material_bar_events
    WHERE stock_movement_id=$1::uuid ORDER BY bar_id`, [original.id])).rows;
  const plan = planMaterialBarCompensation({ original: { ...original, batchId: original.batchId }, source,
    destinationBatchId: input.destinationBatchId, proofs });
  assertInitialLengths(source, plan);
  let transfer: PreparedMaterialBarMovement | undefined;
  if (plan.kind === 'TRANSFER') {
    const destination = inventories.get(input.destinationBatchId!)!;
    transfer = await prepareMaterialBarMovementTx(tx, { movementId: movement.id, sourceBatchId: source.batch.id,
      destinationBatchId: destination.batch.id, command: { kind: 'TRANSFER', expectedVersion: source.version,
        expectedDestinationVersion: destination.version, bars: plan.changes.map(c => ({ barId: c.bar.id, expectedVersion: c.bar.version })) } });
  }
  const token = Object.freeze({ kind: 'COMPENSATION' as const });
  prepared.set(token, { tx, value: { kind: 'COMPENSATION', movement, originalId: original.id, source, plan, transfer } });
  return token;
}

/** Complete within the canonical posting transaction. Historical rows remain
 * immutable; unused incoming bars are retired, never deleted or recreated. */
export async function applyMaterialBarCompensationTx(tx: Db, token: PreparedMaterialBarCompensation, actor: number) {
  const entry = prepared.get(token);
  if (!entry || entry.tx !== tx) changed('Préparez la compensation dans la transaction de ce mouvement.');
  const { movement, originalId, source, plan, transfer } = entry.value;
  const posted = await readMovement(tx, movement.id);
  if (posted.status !== 'POSTED' || posted.batchId !== movement.batchId || posted.reversalOf !== originalId
    || posted.articleId !== movement.articleId || posted.type !== movement.type || posted.quantity !== movement.quantity)
    changed('Le mouvement comptabilisé ne correspond pas à la compensation préparée.');
  if (transfer) {
    await applyMaterialBarMovementTx(tx, transfer, actor);
  } else {
    const current = await readMaterialBarInventoryTx(tx, source.batch.id);
    const delta = plan.kind === 'RESTORE' ? milli(plan.quantityMm) : -milli(plan.quantityMm);
    if (source.revision !== current.revision || source.batch.reservedMm !== current.batch.reservedMm
      || JSON.stringify([source.bars,source.holds,source.reservations]) !== JSON.stringify([current.bars,current.holds,current.reservations])
      || milli(current.batch.physicalMm) !== milli(source.batch.physicalMm) + delta
      || BigInt(current.batch.movementCount) !== BigInt(source.batch.movementCount) + 1n)
      changed('Le stock ou les réservations ont changé pendant la compensation.');
    for (const change of plan.changes) {
      const retire = plan.kind === 'RETIRE';
      const updated = await tx.query(`UPDATE public.stock_material_bars SET remaining_length_mm=$3,
        retired_at=CASE WHEN $4 THEN now() ELSE NULL END,row_version=row_version+1,updated_at=now(),updated_by=$5
        WHERE id=$1::uuid AND row_version=$2 AND stock_batch_id=$6::uuid AND retired_at IS NULL RETURNING id`,
      [change.bar.id,change.bar.version,change.restoredMm,retire,actor,source.batch.id]);
      if (updated.rows.length !== 1) changed('Une barre a changé pendant la compensation.');
      await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
        VALUES($1::uuid,$2::uuid,'COMPENSATE',$2::uuid,$3::jsonb,$4::jsonb,'Compensation du mouvement de stock des barres',$5)`,
      [change.bar.id,movement.id,JSON.stringify(change.bar),JSON.stringify({ ...change.bar,lengthMm:change.restoredMm,
        version:change.nextVersion,retired:retire,source:'STOCK_COMPENSATION',reversalOf:originalId }),actor]);
    }
    await tx.query(`UPDATE public.stock_material_bar_inventories SET movement_count=$2::bigint,row_version=row_version+1,
      confirmed_at=now(),confirmed_by=$3,note='Compensation des barres confirmée' WHERE stock_batch_id=$1::uuid`,
    [source.batch.id,current.batch.movementCount,actor]);
    const result = await readMaterialBarInventoryTx(tx, source.batch.id);
    if (result.status !== 'CONFIRMED') changed(result.warning ?? 'Le stock et les barres ne correspondent pas après compensation.');
  }
  prepared.delete(token);
}
