import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { reserveProducedDeliveryDemands } from '../../production/repository/receipt-delivery-reservations.repository';
import { repoCreateMovement, repoPostMovement } from '../../stock/repository/stock.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import type { readUrgencyRestitutionTx } from './urgency-restitution-preview.repository';

type Review = Awaited<ReturnType<typeof readUrgencyRestitutionTx>>;
function exactQuantity(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || parseCumpDecimal(String(amount)) !== parseCumpDecimal(value))
    throw new HttpError(422, 'URGENCY_RETURN_PRECISION', 'Vérifiez la précision de la quantité à restituer.');
  return amount;
}

/** The caller holds quality, recovery, order, stock and reservation locks.
 * Both the logical reservation and any physical surplus transfer share its transaction. */
export async function restoreUrgencyStockTx(tx: PoolClient, args: {
  restorationId: string; review: Review; audit: AuditContext;
}) {
  const { review, audit, restorationId } = args;
  const target = review.evidence.routing.destinations.find(row => row.lane === 'FREE');
  if (!target?.valid) throw new HttpError(409, 'URGENCY_RETURN_LANES_REQUIRED', 'La piste de stock libre doit être disponible.');
  for (const line of review.response.lines) {
    const source = review.evidence.reservations.find(row => row.id === line.reservation_id)!;
    const donor = review.evidence.recoveries.find(row => row.id === line.recovery_id)!;
    const before = (await tx.query<{ snapshot: unknown }>('SELECT to_jsonb(r) AS snapshot FROM public.stock_reservations r WHERE id=$1::uuid FOR UPDATE', [source.id])).rows[0];
    const released = (await tx.query<{ snapshot: unknown }>(`UPDATE public.stock_reservations SET
      status=CASE WHEN qty_reserved=$2 THEN 'RELEASED' ELSE 'ACTIVE' END,
      qty_reserved=CASE WHEN qty_reserved=$2 THEN qty_reserved ELSE qty_reserved-$2 END,
      released_at=CASE WHEN qty_reserved=$2 THEN now() ELSE released_at END,
      released_by=CASE WHEN qty_reserved=$2 THEN $3 ELSE released_by END,
      release_reason=CASE WHEN qty_reserved=$2 THEN 'Restitution du prélèvement urgent' ELSE release_reason END,
      version=version+1,updated_at=now(),updated_by=$3
      WHERE id=$1::uuid AND status='ACTIVE' AND qty_consumed=0 AND qty_prepared=0 AND qty_reserved>=$2
      RETURNING to_jsonb(stock_reservations) AS snapshot`, [source.id, line.quantity, audit.user_id])).rows[0];
    if (!before || !released) throw new HttpError(409, 'URGENCY_RETURN_CHANGED', 'La réservation a changé. Actualisez le retour.');
    const level = await tx.query(`UPDATE public.stock_levels SET qty_reserved=qty_reserved-$2,updated_at=now(),updated_by=$3
      WHERE id=$1::uuid AND qty_reserved>=$2 RETURNING id`, [source.stock_level_id, line.quantity, audit.user_id]);
    const batch = await tx.query('UPDATE public.stock_batches SET qty_reserved=qty_reserved-$2 WHERE id=$1::uuid AND qty_reserved>=$2 RETURNING id',
      [source.stock_batch_id, line.quantity]);
    if (level.rowCount !== 1 || batch.rowCount !== 1) throw new HttpError(409, 'URGENCY_RETURN_CHANGED', 'Le stock réservé a changé. Actualisez le retour.');
    let donorReservationId: string | null = null;
    if (parseCumpDecimal(line.donor_quantity) > 0n) {
      const reserved = await reserveProducedDeliveryDemands(tx, { ...source,
        commande_ligne_id: donor.commande_ligne_id, livraison_affaire_id: donor.livraison_affaire_id,
        qty_ok: exactQuantity(line.donor_quantity), actor_user_id: audit.user_id, quality_gate_already_held: true,
        reservation_reason: 'Restitution des pièces prêtées pour une urgence annulée' });
      if (!reserved || reserved.reservation_ids.length !== 1 || parseCumpDecimal(String(reserved.qty_reserved)) !== parseCumpDecimal(line.donor_quantity))
        throw new HttpError(409, 'URGENCY_RETURN_DONOR_CHANGED', 'Le besoin de l’affaire donneuse a changé. Actualisez le retour.');
      donorReservationId = reserved.reservation_id;
    }
    let movementId: string | null = null;
    if (parseCumpDecimal(line.free_quantity) > 0n) {
      const amount = exactQuantity(line.free_quantity);
      const key = `urgency-restitution:${restorationId}:${line.transfer_id}`;
      const movement = await repoCreateMovement({ movement_type: 'TRANSFER', source_document_type: 'URGENCY_RESTITUTION',
        source_document_id: restorationId, reason_code: 'URGENCY_RESTITUTION', notes: 'Surplus après restitution du prélèvement urgent',
        idempotency_key: `${key}:create`, lines: [{ article_id: source.article_id, lot_id: source.lot_id, qty: amount, unite: source.unit,
          src_magasin_id: source.magasin_id, src_emplacement_id: source.emplacement_id,
          dst_magasin_id: target.magasin_id, dst_emplacement_id: target.emplacement_id }] }, audit, { client: tx, trusted_source_flow: true });
      const posted = await repoPostMovement(movement.movement.id, {}, audit, `${key}:post`, tx);
      if (posted?.movement.status !== 'POSTED') throw new Error('URGENCY_RETURN_TRANSFER_NOT_POSTED');
      movementId = posted.movement.id;
    }
    await tx.query(`INSERT INTO public.delivery_urgency_restitution_lines
      (restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,free_movement_id,reservation_evidence)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb)`, [restorationId,line.transfer_id,donorReservationId,
      line.donor_quantity,line.free_quantity,movementId,JSON.stringify({ before: before.snapshot, after: released.snapshot })]);
  }
}
