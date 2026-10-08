import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { assemblyComponentWithdrawalOwnsMovement } from './assembly-component-movement-guard';
import { restoreMaterialReservationTx } from './material-compensation.repository';
import { repoGetMovement, repoCreateMovement, repoPostMovement, type AuditContext } from './stock.repository';
import { ASSEMBLY_RETURN_PROOF_SQL } from './assembly-component-return.sql';

/** Production owns eligibility and the planning/OF/all-lot locks. Stock owns
 * the exact inverse and restoration; neither effect may commit on its own. */
export async function returnAssemblyComponentTx(tx: PoolClient, input: {
  ofId: number; movementId: string; reservationId: string; quantity: number; key: string; reason: string;
}, audit: AuditContext) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stock-compensation:${input.movementId}`]);
  await tx.query('SELECT id FROM public.stock_movements WHERE id=$1::uuid FOR UPDATE', [input.movementId]);
  if (!await assemblyComponentWithdrawalOwnsMovement(tx, input.movementId)
    || (await tx.query("SELECT 1 FROM public.stock_movements WHERE reversal_of_id=$1::uuid AND status::text<>'CANCELLED'", [input.movementId])).rowCount) {
    throw new HttpError(409, 'ASSEMBLY_COMPONENT_ALREADY_RETURNED', 'Cette sortie a déjà été corrigée ou sa preuve de montage manque.');
  }
  const original = await repoGetMovement(input.movementId, tx);
  if (!original || original.movement.status !== 'POSTED' || original.movement.movement_type !== 'OUT'
    || original.lines.length !== 1 || Math.abs(original.lines[0].qty) !== input.quantity) {
    throw new HttpError(409, 'ASSEMBLY_RETURN_PROOF_CHANGED', 'La sortie ne correspond plus à la mise en montage choisie.');
  }
  const line = original.lines[0];
  const created = await repoCreateMovement({ movement_type: 'IN', source_document_type: 'STOCK_COMPENSATION',
    source_document_id: input.movementId, reason_code: 'COMPENSATION', notes: input.reason,
    idempotency_key: `${input.key}:create`, lines: [{ article_id: line.article_id, lot_id: line.lot_id,
      qty: input.quantity, unite: line.unite, unit_cost: line.unit_cost, currency: line.currency,
      dst_magasin_id: line.src_magasin_id, dst_emplacement_id: line.src_emplacement_id, note: input.reason }] },
  audit, { client: tx, trusted_source_flow: true });
  await tx.query('UPDATE public.stock_movements SET reversal_of_id=$2::uuid WHERE id=$1::uuid', [created.movement.id, input.movementId]);
  const posted = await repoPostMovement(created.movement.id, {}, audit, `${input.key}:post`, tx);
  if (posted?.movement.status !== 'POSTED'
    || (await tx.query(ASSEMBLY_RETURN_PROOF_SQL, [input.movementId, created.movement.id, input.ofId, input.reservationId, input.quantity])).rows.length !== 1) {
    throw new HttpError(409, 'ASSEMBLY_RETURN_TRACEABILITY_REQUIRED', 'Le retour ne possède pas sa preuve complète. Aucune correction n’est conservée.');
  }
  await restoreMaterialReservationTx(tx, { reservationId: input.reservationId, quantity: input.quantity, reason: input.reason }, audit);
  return { reservationId: input.reservationId, originalMovementId: input.movementId,
    stockMovementId: created.movement.id, quantity: input.quantity };
}
