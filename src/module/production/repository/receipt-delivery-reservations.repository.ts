import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { allocateReceiptToDeliveryDemands, type ReceiptDeliveryDemand } from "../domain/receipt-delivery-allocation";

export type ProducedDeliveryReservationArgs = {
  commande_ligne_id: number; article_id: string; location_id: string; stock_level_id: string;
  stock_batch_id: string; lot_id: string; qty_ok: number; actor_user_id: number;
  of_id?: number | null; quality_gate_already_held?: boolean; livraison_affaire_id?: number | null;
  source_scope?: string;
};
export type ProducedDeliveryReservation = {
  reservation_id: string;
  reservation_ids: string[];
  qty_reserved: number;
};

/** Reserve each actual affair remainder, in current AR order, under the caller's transaction. */
export async function reserveProducedDeliveryDemands(
  tx: Pick<PoolClient, "query">,
  args: ProducedDeliveryReservationArgs,
): Promise<ProducedDeliveryReservation | null> {
  if (!Number.isFinite(args.qty_ok) || args.qty_ok <= 0) return null;
  const line = (await tx.query<{ ordered: string; article_id: string | null }>(
    `SELECT quantite::text AS ordered,article_id::text FROM public.commande_ligne
      WHERE id=$1::bigint FOR UPDATE`, [args.commande_ligne_id])).rows[0];
  if (!line) return null;
  if (line.article_id && line.article_id !== args.article_id)
    throw new HttpError(409, "ARTICLE_MISMATCH", "La ligne de commande ne correspond pas à l'article reçu.");
  // Lock all allocations before reading their canonical reservations. An explicit affair
  // restricts the result, not the order-wide coverage check.
  const identities = (await tx.query<{ id: number }>(
    `SELECT id::bigint::int FROM public.commande_ligne_affaire_allocation
      WHERE commande_ligne_id=$1::bigint ORDER BY id FOR UPDATE`, [args.commande_ligne_id])).rows;
  if (!identities.length)
    throw new HttpError(409, "COMMANDE_ALLOCATION_NOT_FOUND", "Créez l'affaire de livraison avant de réserver cette réception.");
  const unlinked = (await tx.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM public.bon_livraison_ligne line
      JOIN public.bon_livraison delivery ON delivery.id=line.bon_livraison_id
      WHERE line.commande_ligne_id=$1::bigint AND delivery.statut<>'CANCELLED'
        AND NOT EXISTS(SELECT 1 FROM public.bon_livraison_ligne_allocations a
          WHERE a.bon_livraison_ligne_id=line.id)) AS exists`, [args.commande_ligne_id])).rows[0];
  if (unlinked?.exists)
    throw new HttpError(409, "LEGACY_DELIVERY_COVERAGE_REVIEW_REQUIRED", "Un ancien BL n'est pas relié à ses lots. Vérifiez sa couverture avant de réserver davantage.");
  const demands = (await tx.query<ReceiptDeliveryDemand>(
    `SELECT allocation.id::bigint::int AS allocation_id,
      allocation.livraison_affaire_id::bigint::int,allocation.qty_ordered::text AS ordered,
      allocation.qty_delivered::text AS delivered,
      COALESCE(reserved.quantity,0)::text AS reserved_remaining,
      COALESCE(prepared.quantity,0)::text AS unreserved_prepared,
      COALESCE(promise.due_date,line.delai_client)::text AS due_date
    FROM public.commande_ligne_affaire_allocation allocation
    JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id
    LEFT JOIN LATERAL (SELECT sum(r.qty_reserved-r.qty_consumed) AS quantity
      FROM public.stock_reservations r WHERE r.commande_ligne_affaire_allocation_id=allocation.id
        AND r.status='ACTIVE') reserved ON true
    LEFT JOIN LATERAL (SELECT sum(a.quantite-a.qty_consumed) AS quantity
      FROM public.bon_livraison_ligne_allocations a
      JOIN public.bon_livraison_ligne bl_line ON bl_line.id=a.bon_livraison_ligne_id
      JOIN public.bon_livraison delivery ON delivery.id=bl_line.bon_livraison_id
      WHERE a.commande_ligne_affaire_allocation_id=allocation.id AND a.reservation_id IS NULL
        AND delivery.statut NOT IN ('CANCELLED','SHIPPED','DELIVERED')) prepared ON true
    LEFT JOIN LATERAL (SELECT min(part.due_date) AS due_date
      FROM public.delivery_promise_roots root JOIN public.delivery_promise_parts part ON part.root_id=root.id
      WHERE root.allocation_id=allocation.id AND part.retired_at IS NULL
        AND part.quantity>COALESCE((SELECT sum(shipped.quantity) FROM public.delivery_promise_shipments shipped
          WHERE shipped.part_id=part.id),0)) promise ON true
    WHERE allocation.commande_ligne_id=$1::bigint ORDER BY allocation.id`, [args.commande_ligne_id])).rows;
  if (args.livraison_affaire_id != null && !demands.some(d => d.livraison_affaire_id === args.livraison_affaire_id))
    throw new HttpError(409, "COMMANDE_ALLOCATION_NOT_FOUND", "Cette affaire n'appartient pas à la ligne commandée.");
  const plan = allocateReceiptToDeliveryDemands(String(args.qty_ok), line.ordered, demands, args.livraison_affaire_id ?? null);
  if (!plan.length) return null;
  const total = plan.reduce((sum, item) => sum + parseCumpDecimal(item.quantity), 0n);
  const quantity = formatCumpDecimal(total);
  if (!args.quality_gate_already_held)
    await assertOperationalLotQualityEligibility({ client: tx, lotId: args.lot_id, qty: Number(quantity), purpose: "RESERVE" });
  const level = (await tx.query<{ available: string }>(
    `SELECT (qty_total-qty_reserved-qty_depreciated)::text AS available FROM public.stock_levels
      WHERE id=$1::uuid AND article_id=$2::uuid AND location_id=$3::uuid FOR UPDATE`,
    [args.stock_level_id, args.article_id, args.location_id])).rows[0];
  const batch = (await tx.query<{ available: string }>(
    `SELECT (qty_total-qty_reserved-qty_depreciated)::text AS available FROM public.stock_batches
      WHERE id=$1::uuid AND stock_level_id=$2::uuid AND lot_id=$3::uuid FOR UPDATE`,
    [args.stock_batch_id, args.stock_level_id, args.lot_id])).rows[0];
  if (!level || !batch || parseCumpDecimal(level.available, true) < total || parseCumpDecimal(batch.available, true) < total)
    throw new HttpError(409, "INSUFFICIENT_LOT_STOCK", "Le stock disponible du lot a changé. Actualisez la réception.");
  const reservationIds: string[] = [];
  for (const item of plan) {
    const reservation = (await tx.query<{ id: string }>(
      `INSERT INTO public.stock_reservations(article_id,location_id,qty_reserved,source_type,source_id,
        commande_ligne_id,affaire_id,status,lot_id,stock_batch_id,commande_ligne_affaire_allocation_id,
        livraison_affaire_id,stock_level_id,of_id,source_scope,reason,created_by,updated_by)
      VALUES($1::uuid,$2::uuid,$3,'COMMANDE_LIGNE',$4::bigint::text,$4::bigint,$8::bigint,'ACTIVE',
        $5::uuid,$6::uuid,$7::bigint,$8::bigint,$9::uuid,$10::bigint,$11,$12,$13,$13)
      ON CONFLICT(commande_ligne_affaire_allocation_id,stock_batch_id)
        WHERE status='ACTIVE' AND commande_ligne_affaire_allocation_id IS NOT NULL AND stock_batch_id IS NOT NULL
      DO UPDATE SET qty_reserved=stock_reservations.qty_reserved+excluded.qty_reserved,
        version=stock_reservations.version+1,updated_at=now(),updated_by=excluded.updated_by
      RETURNING id::text`, [args.article_id, args.location_id, item.quantity, args.commande_ligne_id,
        args.lot_id, args.stock_batch_id, item.allocation_id, item.livraison_affaire_id, args.stock_level_id,
        args.of_id ?? null, args.source_scope ?? "NEW", "Production réservée au restant de l'affaire de livraison", args.actor_user_id])).rows[0];
    if (!reservation) throw new Error("PRODUCTION_DELIVERY_RESERVATION_NOT_CREATED");
    reservationIds.push(reservation.id);
  }
  await tx.query(`UPDATE public.stock_levels SET qty_reserved=qty_reserved+$2,updated_at=now(),updated_by=$3
    WHERE id=$1::uuid`, [args.stock_level_id, quantity, args.actor_user_id]);
  await tx.query("UPDATE public.stock_batches SET qty_reserved=qty_reserved+$2 WHERE id=$1::uuid", [args.stock_batch_id, quantity]);
  await tx.query(`UPDATE public.commande_ligne_affaire_allocation allocation
    SET qty_reserved=totals.quantity,qty_from_stock=LEAST(allocation.qty_ordered,allocation.qty_delivered+totals.quantity),
      qty_to_produce=GREATEST(0,allocation.qty_ordered-allocation.qty_delivered-totals.quantity),
      qty_remaining=GREATEST(0,allocation.qty_ordered-allocation.qty_delivered),
      allocation_version=allocation_version+1,updated_at=now()
    FROM (SELECT r.commande_ligne_affaire_allocation_id AS id,sum(r.qty_reserved-r.qty_consumed) AS quantity
      FROM public.stock_reservations r WHERE r.commande_ligne_affaire_allocation_id=ANY($1::bigint[])
        AND r.status='ACTIVE' GROUP BY r.commande_ligne_affaire_allocation_id) totals
    WHERE allocation.id=totals.id`, [plan.map(item => item.allocation_id)]);
  return { reservation_id: reservationIds[0], reservation_ids: reservationIds, qty_reserved: Number(quantity) };
}
