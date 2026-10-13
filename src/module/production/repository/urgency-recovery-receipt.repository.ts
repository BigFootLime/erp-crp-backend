import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { reserveProducedDeliveryDemands, type ProducedDeliveryReservationArgs } from './receipt-delivery-reservations.repository';

type Recovery = {
  id: string; request_id: string; status: string; donor_allocation_id: number;
  quantity: string; restored: string; commande_ligne_id: number; livraison_affaire_id: number;
  identity_valid: boolean;
};

/** Reserve the actual released output for its original donor, never for a mutable OF link.
 * The receipt and its later lane assignment commit in the caller's transaction. */
export async function reserveUrgencyRecoveryReceiptTx(
  tx: Pick<PoolClient, 'query'>,
  args: Omit<ProducedDeliveryReservationArgs, 'commande_ligne_id'> & { of_id: number; receipt_id: string },
) {
  const recovery = (await tx.query<Recovery>(`SELECT recovery.id::text,recovery.request_id::text,request.status,
    recovery.donor_allocation_id::int,recovery.quantity::text,
    COALESCE((SELECT sum(quantity) FROM public.delivery_urgency_replenishments replenishment
      WHERE replenishment.recovery_id=recovery.id),0)::text AS restored,
    donor.commande_ligne_id::int,donor.livraison_affaire_id::int,
    (producer.commande_id=donor.commande_id AND producer.commande_ligne_id=donor.commande_ligne_id
      AND producer.affaire_id=donor.livraison_affaire_id AND line.article_id=$2::uuid
      AND producer.piece_technique_id::text=recovery.donor_snapshot->>'piece_technique_id'
      AND producer.piece_technique_version_id::text=recovery.donor_snapshot->>'technical_version_id') AS identity_valid
    FROM public.delivery_urgency_recoveries recovery
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    JOIN public.commande_ligne_affaire_allocation donor ON donor.id=recovery.donor_allocation_id
    JOIN public.commande_ligne line ON line.id=donor.commande_ligne_id
    JOIN public.ordres_fabrication producer ON producer.id=recovery.recovery_of_id
    WHERE recovery.recovery_of_id=$1::bigint FOR UPDATE OF recovery NOWAIT`, [args.of_id, args.article_id])
    .catch((error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (['55P03', '40P01', '40001'].includes(code))
        throw new HttpError(409, 'URGENCY_RECOVERY_BUSY', 'Une autre opération utilise cette récupération. Actualisez avant de réceptionner.');
      throw error;
    })).rows[0];
  if (!recovery) return null;
  if (!recovery.identity_valid)
    throw new HttpError(409, 'URGENCY_RECOVERY_DESTINATION_CHANGED', 'La récupération doit rester liée à la commande, à l’affaire et à la pièce donneuses.');
  if (recovery.status === 'WAITING_PLANNER')
    throw new HttpError(409, 'URGENCY_RECOVERY_NOT_APPROVED', 'Le planificateur doit valider cette récupération.');
  const empty = { matched: true as const, reservation_id: null, reservation_ids: [] as string[], qty_reserved: 0 };
  // A completed recovery before withdrawal is still real free stock. It must not
  // create a fictitious repayment while the donor keeps all of its reservations.
  if (recovery.status !== 'WITHDRAWN') return empty;
  const remaining = parseCumpDecimal(recovery.quantity) - parseCumpDecimal(recovery.restored);
  const received = parseCumpDecimal(String(args.qty_ok));
  const amount = remaining < received ? remaining : received;
  if (amount <= 0n) return empty;
  const reserved = await reserveProducedDeliveryDemands(tx, { ...args,
    commande_ligne_id: recovery.commande_ligne_id, livraison_affaire_id: recovery.livraison_affaire_id,
    qty_ok: Number(formatCumpDecimal(amount)),
    reservation_reason: 'Récupération des pièces prêtées pour une livraison urgente',
  });
  if (!reserved) return empty;
  // An affair has one allocation per order line. Never aggregate another affair
  // into the evidence if an inconsistent legacy allocation is encountered.
  if (reserved.reservation_ids.length !== 1)
    throw new HttpError(409, 'URGENCY_RECOVERY_ALLOCATION_AMBIGUOUS', 'Vérifiez la répartition de l’affaire donneuse.');
  await tx.query(`INSERT INTO public.delivery_urgency_replenishments
    (recovery_id,receipt_id,reservation_id,lot_id,quantity,created_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)`,
    [recovery.id,args.receipt_id,reserved.reservation_id,args.lot_id,String(reserved.qty_reserved),args.actor_user_id]);
  return { ...reserved, matched: true as const };
}
