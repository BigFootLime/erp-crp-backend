import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { isLotExpired } from '../../qualite/domain/lot-shelf-life';
import { readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { planUrgencyRestitution, type UrgencyRestitutionRecovery, type UrgencyRestitutionTransfer,
  type UrgencyRestitutionReservation } from '../domain/urgency-restitution';

type Db = Pick<PoolClient, 'query'>;
type Reservation = Omit<UrgencyRestitutionReservation, 'blocker'> & {
  snapshot: unknown; lot_id: string; lot_status: string; expiry_at: string | null;
  source_scope: string; old_documents: boolean; physical_covered: boolean;
};

/** Call from a consistent read transaction. This is a proposal only, never a
 * permission to release a reservation or alter a charge. */
export async function readUrgencyRestitutionTx(tx: Db, requestId: string) {
  const request = (await tx.query<{ quantity: string; status: string; commande_id: string }>(`SELECT request.quantity::text,
    request.status,allocation.commande_id::text FROM public.delivery_urgency_requests request
    JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id
    WHERE request.id=$1::uuid`, [requestId])).rows[0];
  if (!request) throw new HttpError(404, 'URGENCY_REQUEST_NOT_FOUND', 'Demande urgente introuvable.');
  if (request.status !== 'WITHDRAWN') throw new HttpError(409, 'URGENCY_NOT_WITHDRAWN', 'Cette urgence ne comporte pas de prélèvement à restituer.');
  const recoveries = (await tx.query<UrgencyRestitutionRecovery>(`SELECT recovery.id::text,recovery.quantity::text,
    COALESCE((SELECT sum(quantity) FROM public.delivery_urgency_replenishments WHERE recovery_id=recovery.id),0)::text AS replenished,
    GREATEST(0,donor.qty_ordered-donor.qty_delivered
      -COALESCE((SELECT sum(r.qty_reserved-r.qty_consumed) FROM public.stock_reservations r
        WHERE r.commande_ligne_affaire_allocation_id=donor.id AND r.status='ACTIVE'),0)
      -COALESCE((SELECT sum(part.quantite-part.qty_consumed) FROM public.bon_livraison_ligne_allocations part
        JOIN public.bon_livraison_ligne line ON line.id=part.bon_livraison_ligne_id
        JOIN public.bon_livraison delivery ON delivery.id=line.bon_livraison_id
        WHERE part.commande_ligne_affaire_allocation_id=donor.id AND part.reservation_id IS NULL
          AND delivery.statut NOT IN ('CANCELLED','SHIPPED','DELIVERED')),0))::text AS donor_uncovered
    FROM public.delivery_urgency_recoveries recovery JOIN public.commande_ligne_affaire_allocation donor ON donor.id=recovery.donor_allocation_id
    WHERE recovery.request_id=$1::uuid ORDER BY recovery.id`, [requestId])).rows;
  const transfers = (await tx.query<UrgencyRestitutionTransfer>(`SELECT transfer.id::text,source.recovery_id::text,
    transfer.beneficiary_reservation_id::text AS reservation_id,transfer.quantity::text
    FROM public.delivery_urgency_transfers transfer JOIN public.delivery_urgency_sources source ON source.id=transfer.source_id
    JOIN public.delivery_urgency_withdrawals withdrawal ON withdrawal.id=transfer.withdrawal_id
    WHERE withdrawal.request_id=$1::uuid ORDER BY source.recovery_id,transfer.id`, [requestId])).rows;
  const rows = (await tx.query<Reservation>(`SELECT reservation.id::text,to_jsonb(reservation) AS snapshot,
    (reservation.qty_reserved-reservation.qty_consumed)::text AS remaining,
    reservation.qty_prepared::text AS prepared,reservation.qty_consumed::text AS consumed,
    reservation.lot_id::text,lot.lot_status::text,lot.expiry_at::text,reservation.source_scope,
    (reservation.status IN ('ACTIVE','CONSUMED') AND lane.lane='DELIVERY'
      AND level.article_id=reservation.article_id AND level.location_id=reservation.location_id AND NOT EXISTS(
      SELECT 1 FROM public.delivery_urgency_transfers transfer
      JOIN public.delivery_urgency_withdrawals withdrawal ON withdrawal.id=transfer.withdrawal_id
      JOIN public.delivery_urgency_requests request ON request.id=withdrawal.request_id
      WHERE withdrawal.request_id=$1::uuid AND transfer.beneficiary_reservation_id=reservation.id
        AND (reservation.commande_ligne_affaire_allocation_id IS DISTINCT FROM request.beneficiary_allocation_id
          OR reservation.stock_batch_id::text IS DISTINCT FROM transfer.reservation_evidence->'beneficiary'->>'stock_batch_id'
          OR reservation.stock_level_id::text IS DISTINCT FROM transfer.reservation_evidence->'beneficiary'->>'stock_level_id'
          OR reservation.location_id::text IS DISTINCT FROM transfer.reservation_evidence->'beneficiary'->>'location_id'
          OR reservation.lot_id::text IS DISTINCT FROM transfer.reservation_evidence->'beneficiary'->>'lot_id'
          OR reservation.article_id::text IS DISTINCT FROM transfer.reservation_evidence->'beneficiary'->>'article_id'))) AS identity_valid,
    (batch.qty_total-batch.qty_depreciated>=batch.qty_reserved
      AND level.qty_total-level.qty_depreciated>=level.qty_reserved
      AND batch.qty_reserved>=COALESCE((SELECT sum(r.qty_reserved-r.qty_consumed) FROM public.stock_reservations r
        WHERE r.stock_batch_id=batch.id AND r.status='ACTIVE'),0)
      AND level.qty_reserved>=COALESCE((SELECT sum(r.qty_reserved-r.qty_consumed) FROM public.stock_reservations r
        WHERE r.stock_level_id=level.id AND r.status='ACTIVE'),0)) AS physical_covered,
    EXISTS(SELECT 1 FROM public.old_stock_document_references legacy WHERE legacy.lot_id=reservation.lot_id) AS old_documents
    FROM public.stock_reservations reservation
    JOIN public.lots lot ON lot.id=reservation.lot_id
    JOIN public.stock_batches batch ON batch.id=reservation.stock_batch_id AND batch.lot_id=reservation.lot_id
    JOIN public.stock_levels level ON level.id=reservation.stock_level_id AND batch.stock_level_id=level.id
    LEFT JOIN public.stock_lane_locations lane ON lane.location_id=reservation.location_id
    WHERE reservation.id=ANY($2::uuid[]) ORDER BY reservation.id`,
  [requestId, [...new Set(transfers.map(row => row.reservation_id))]])).rows;
  const quality = new Map<string, Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
  const reservations: UrgencyRestitutionReservation[] = [];
  for (const row of rows) {
    let blocker: string | null = null;
    if (!row.physical_covered) blocker = 'Le stock physique ne couvre plus les réservations. Rapprochez le lot.';
    else if (!['OLD', 'NEW'].includes(row.source_scope)) blocker = 'Origine du lot à vérifier.';
    else if (row.lot_status !== 'LIBERE') blocker = 'Lot non libéré par la qualité.';
    else if (isLotExpired(row.expiry_at, new Date())) blocker = 'Lot périmé.';
    else if (row.source_scope === 'OLD' && !row.old_documents) blocker = 'Dossier historique OLD manquant.';
    else if (row.source_scope === 'NEW') {
      let control = quality.get(row.lot_id);
      if (!control) { control = await readOperationalLotQualityEligibility({ client: tx, lotId: row.lot_id, qty: 0, purpose: 'RESERVE' }); quality.set(row.lot_id, control); }
      if (!control.eligibility.allowed) blocker = control.eligibility.blocks[0]?.message ?? 'Lot bloqué par la qualité.';
    }
    reservations.push({ ...row, blocker });
  }
  const fee = (await tx.query<{ id: string; amount_ht: string; currency: string; invoice_id: string | null;
    invoice_number: string | null; invoice_status: string | null; other_withdrawals: number }>(`SELECT charge.id::text,
    charge.amount_ht::text,charge.currency,invoice.id::text AS invoice_id,invoice.numero AS invoice_number,
    COALESCE(invoice.document_status,invoice.statut)::text AS invoice_status,
    (SELECT count(*)::int FROM public.delivery_urgency_requests other
      JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=other.beneficiary_allocation_id
      WHERE allocation.commande_id=charge.commande_id AND other.status='WITHDRAWN' AND other.id<>$1::uuid) AS other_withdrawals
    FROM public.delivery_urgency_order_charges charge LEFT JOIN public.facture_urgency_charges binding ON binding.charge_id=charge.id
    LEFT JOIN public.facture invoice ON invoice.id=binding.facture_id WHERE charge.commande_id=$2::bigint`, [requestId, request.commande_id])).rows[0] ?? null;
  return { evidence: { request, recoveries, transfers, reservations: rows, fee },
    response: { ...planUrgencyRestitution({ quantity: request.quantity, recoveries, transfers, reservations }), fee } };
}
