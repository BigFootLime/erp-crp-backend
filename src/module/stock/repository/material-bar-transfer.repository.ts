import type { PoolClient } from 'pg';
import { z } from 'zod';
import { HttpError } from '../../../utils/httpError';
import { planBarOwnershipTransfer, planBarOwnershipRestoration,
  type BarOwnershipChange, type BarRestorationGroup } from '../domain/material-bar-transfer';
import { readTrackedMaterialBarInventoryTx } from './material-bar-holds.repository';
import { readMaterialBarInventoryTx } from './material-bar-inventory.repository';

type Db = Pick<PoolClient, 'query'>;
type Audit = { actor: number; commandKey: string; contextId: string; reason: string };
function changed(): never {
  throw new HttpError(409, 'MATERIAL_BAR_TRANSFER_CHANGED', 'Les barres ont changé. Actualisez le regroupement.');
}

/** Call before changing canonical ownership, under the lot/stock locks. */
export async function prepareMaterialBarTransferTx(tx: Db, batchId: string, sourceIds: string[], targetId?: string) {
  const current = await readTrackedMaterialBarInventoryTx(tx, batchId);
  if (!current) return null;
  if (sourceIds.some(id => !current.reservations.some(r => r.id === id))
    || targetId && !current.reservations.some(r => r.id === targetId)) changed();
  return { current, sourceIds, targetId };
}

async function writeAssignmentsTx(tx: Db, change: BarOwnershipChange, actor: number) {
  const updated = await tx.query(`UPDATE public.stock_material_bars SET row_version=row_version+1,updated_at=now(),updated_by=$3
    WHERE id=$1::uuid AND row_version=$2 AND retired_at IS NULL RETURNING id`, [change.bar.id, change.bar.version, actor]);
  if (!updated.rows.length) changed();
  for (const assignment of change.assignments) {
    // Positive existing holds use an UPDATE so a missing row cannot be invented.
    if (assignment.beforeMm > 0) {
      const existing = await tx.query(`UPDATE public.stock_material_bar_reservations SET remaining_length_mm=$3,updated_at=now(),updated_by=$4
        WHERE bar_id=$1::uuid AND reservation_id=$2::uuid AND remaining_length_mm=$5 RETURNING bar_id`,
      [change.bar.id, assignment.reservationId, assignment.afterMm, actor, assignment.beforeMm]);
      if (!existing.rows.length) changed();
    } else {
      const inserted = await tx.query(`INSERT INTO public.stock_material_bar_reservations(bar_id,reservation_id,remaining_length_mm,updated_by)
        VALUES($1::uuid,$2::uuid,$3,$4)
        ON CONFLICT(bar_id,reservation_id) DO UPDATE SET remaining_length_mm=excluded.remaining_length_mm,updated_at=now(),updated_by=excluded.updated_by
        WHERE stock_material_bar_reservations.remaining_length_mm=0 RETURNING bar_id`,
      [change.bar.id, assignment.reservationId, assignment.afterMm, actor]);
      if (!inserted.rows.length) changed();
    }
  }
}

async function finishOwnershipTx(tx: Db, batchIds: string[]) {
  for (const id of new Set(batchIds)) {
    await tx.query('UPDATE public.stock_material_bar_inventories SET row_version=row_version+1 WHERE stock_batch_id=$1::uuid', [id]);
    if ((await readMaterialBarInventoryTx(tx, id)).status !== 'CONFIRMED') changed();
  }
}

/** Canonical source rows are now released and the producer owns their totals.
 * Do not change stock counters or movement versions: no material moved. */
export async function applyMaterialBarTransferTx(tx: Db, plan: Awaited<ReturnType<typeof prepareMaterialBarTransferTx>>,
  input: Audit & { targetReservationId: string }) {
  if (!plan) return;
  if (plan.targetId && plan.targetId !== input.targetReservationId) changed();
  const changes = planBarOwnershipTransfer({ ...plan.current, sourceIds: plan.sourceIds, targetReservationId: input.targetReservationId });
  for (const change of changes) {
    await writeAssignmentsTx(tx, change, input.actor);
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'TRANSFER',$3::jsonb,$4::jsonb,$5,$6)`, [change.bar.id, input.commandKey,
      JSON.stringify({ version: change.bar.version, assignments: change.assignments }),
      JSON.stringify({ ...change.proof, version: change.bar.version + 1, contextId: input.contextId }), input.reason, input.actor]);
  }
  await finishOwnershipTx(tx, [plan.current.batch.id]);
}

const length = z.number().finite().nonnegative().max(1e9);
const proof = z.object({ barId: z.string().uuid(), version: z.number().int().positive(), targetReservationId: z.string().uuid(),
  targetMm: length, transfers: z.array(z.object({ reservationId: z.string().uuid(), quantityMm: length.positive() })) });

/** Capture exact provenance before canonical restoration or surplus release. */
export async function prepareMaterialBarRestorationTx(tx: Db, contextId: string,
  groups: Array<BarRestorationGroup & { batchId: string }>) {
  const inventories = [];
  for (const batchId of [...new Set(groups.map(g => g.batchId))].sort()) {
    const current = await readTrackedMaterialBarInventoryTx(tx, batchId);
    if (current) inventories.push(current);
  }
  if (!inventories.length) return [];
  const rows = (await tx.query<{ after_state: unknown }>(`SELECT after_state FROM public.stock_material_bar_events
    WHERE action='TRANSFER' AND after_state->>'contextId'=$1`, [contextId])).rows;
  const proofs = rows.map(row => { const parsed = proof.safeParse(row.after_state); if (!parsed.success) changed(); return parsed.data; });
  return inventories.map(current => ({ batchId: current.batch.id,
    changes: planBarOwnershipRestoration({ ...current,
      groups: groups.filter(g => g.batchId === current.batch.id),
      proofs: proofs.filter(p => current.bars.some(b => b.id === p.barId)),
    }),
  }));
}

export async function applyMaterialBarRestorationTx(tx: Db, plans: Awaited<ReturnType<typeof prepareMaterialBarRestorationTx>>, input: Audit) {
  for (const plan of plans) for (const change of plan.changes) {
    await writeAssignmentsTx(tx, change, input.actor);
    await tx.query(`INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,before_state,after_state,reason,created_by)
      VALUES($1::uuid,$2::uuid,'RESTORE',$3::jsonb,$4::jsonb,$5,$6)`, [change.bar.id, input.commandKey,
      JSON.stringify({ version: change.bar.version, assignments: change.assignments }),
      JSON.stringify({ version: change.bar.version + 1, contextId: input.contextId, assignments: change.assignments }), input.reason, input.actor]);
  }
  await finishOwnershipTx(tx, plans.map(p => p.batchId));
}
