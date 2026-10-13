import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { reserveProducedDeliveryDemands } from '../../production/repository/receipt-delivery-reservations.repository';
import type { DeliveryUrgencyDonor } from './delivery-urgency.repository';
type Db = Pick<PoolClient, 'query'>;
export type UrgencyStockTransfer = {
    source_id: string;
    donor_reservation_id: string;
    beneficiary_reservation_id: string;
    quantity: string;
    reservation_evidence: unknown;
};
/** Caller owns the transaction, quality/order/stock locks, and current eligibility check. */
export async function transferUrgencyReservationTx(tx: Db, args: {
    sourceId: string;
    source: DeliveryUrgencyDonor;
    quantity: string;
    requestId: string;
    actor: number;
    beneficiary: {
        commande_ligne_id: number;
        livraison_affaire_id: number;
        article_id: string;
    };
}): Promise<UrgencyStockTransfer> {
    const { source, quantity, beneficiary } = args;
    const before = (await tx.query<{
        snapshot: unknown;
    }>('SELECT to_jsonb(r) AS snapshot FROM public.stock_reservations r WHERE id=$1::uuid FOR UPDATE', [source.reservation_id])).rows[0];
    const released = await tx.query<{
        snapshot: unknown;
    }>(`UPDATE public.stock_reservations SET
    status=CASE WHEN qty_reserved=$2 THEN 'RELEASED' WHEN qty_reserved-$2=qty_consumed THEN 'CONSUMED' ELSE 'ACTIVE' END,
    qty_reserved=CASE WHEN qty_reserved=$2 THEN qty_reserved ELSE qty_reserved-$2 END,
    released_at=CASE WHEN qty_reserved=$2 THEN now() ELSE released_at END,
    released_by=CASE WHEN qty_reserved=$2 THEN $3 ELSE released_by END,
    release_reason=CASE WHEN qty_reserved=$2 THEN 'Prélèvement urgent autorisé par le planificateur' ELSE release_reason END,
    version=version+1,updated_at=now(),updated_by=$3
    WHERE id=$1::uuid AND version=$4 AND status='ACTIVE' AND qty_reserved-qty_consumed-qty_prepared>=$2
    RETURNING to_jsonb(stock_reservations) AS snapshot`, [source.reservation_id, quantity, args.actor, source.reservation_version]);
    if (!before || released.rowCount !== 1)
        throw new HttpError(409, 'URGENCY_DONOR_CHANGED', 'La réservation donneuse a changé. Actualisez le prélèvement.');
    const level = await tx.query(`UPDATE public.stock_levels SET qty_reserved=qty_reserved-$2,updated_at=now(),updated_by=$3
    WHERE id=$1::uuid AND qty_reserved>=$2 RETURNING id`, [source.stock_level_id, quantity, args.actor]);
    const batch = await tx.query(`UPDATE public.stock_batches SET qty_reserved=qty_reserved-$2
    WHERE id=$1::uuid AND qty_reserved>=$2 RETURNING id`, [source.stock_batch_id, quantity]);
    if (level.rowCount !== 1 || batch.rowCount !== 1)
        throw new HttpError(409, 'URGENCY_STOCK_CHANGED', 'Le stock ne couvre plus la réservation donneuse.');
    const reserved = await reserveProducedDeliveryDemands(tx, {
        ...beneficiary, location_id: source.location_id, stock_level_id: source.stock_level_id,
        stock_batch_id: source.stock_batch_id, lot_id: source.lot_id, qty_ok: Number(quantity),
        actor_user_id: args.actor, source_scope: source.source_scope, quality_gate_already_held: true,
        reservation_reason: `Prélèvement urgent ${args.requestId} ; récupération rattachée à l’affaire donneuse`,
    });
    if (!reserved || reserved.reservation_ids.length !== 1 || parseCumpDecimal(String(reserved.qty_reserved)) !== parseCumpDecimal(quantity))
        throw new HttpError(409, 'URGENCY_BENEFICIARY_CHANGED', 'Le besoin de l’affaire urgente a changé. Actualisez le contrôle.');
    const destination = (await tx.query<{
        snapshot: unknown;
    }>('SELECT to_jsonb(r) AS snapshot FROM public.stock_reservations r WHERE id=$1::uuid', [reserved.reservation_id])).rows[0];
    return { source_id: args.sourceId, donor_reservation_id: source.reservation_id, beneficiary_reservation_id: reserved.reservation_id, quantity,
        reservation_evidence: { before: before.snapshot, after: released.rows[0].snapshot, beneficiary: destination?.snapshot } };
}
/** Refresh even fully released donors, for which the active-reservation aggregate has no row. */
export async function refreshUrgencyDonorCoverageTx(tx: Db, allocationIds: number[]) {
    await tx.query(`WITH totals AS (SELECT a.id,COALESCE((SELECT sum(r.qty_reserved-r.qty_consumed)
    FROM public.stock_reservations r WHERE r.commande_ligne_affaire_allocation_id=a.id AND r.status='ACTIVE'),0) AS quantity
    FROM public.commande_ligne_affaire_allocation a WHERE a.id=ANY($1::bigint[]))
    UPDATE public.commande_ligne_affaire_allocation a SET qty_reserved=totals.quantity,
      qty_from_stock=LEAST(a.qty_ordered,a.qty_delivered+totals.quantity),
      qty_to_produce=GREATEST(0,a.qty_ordered-a.qty_delivered-totals.quantity),
      qty_remaining=GREATEST(0,a.qty_ordered-a.qty_delivered),allocation_version=allocation_version+1,updated_at=now()
    FROM totals WHERE a.id=totals.id`, [allocationIds]);
}
