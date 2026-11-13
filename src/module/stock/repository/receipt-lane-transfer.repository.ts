import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import { formatCumpDecimal, parseCumpDecimal } from "../domain/cump-decimal";
import { repoCreateMovement, repoPostMovement, type AuditContext } from "./stock.repository";
import type { ReceiptLaneDistribution, ReceiptReservationAllocation } from "../../production/domain/receipt-lane-distribution";
import { getActiveStockLaneDestinationsTx, type StockLaneDestination } from "./stock-lane-routing.repository";

type Reservation = {
  id: string; quantity: string; consumed: string; prepared: string;
  allocation_id: number | null; component_id: string | null;
};
type Route = {
  lane: "FREE" | "DELIVERY" | "ASSEMBLY"; quantity: string; source_location_id: string;
    location_id: string; location_label: string; stock_level_id: string; stock_batch_id: string; movement_id: string | null;
  reservations: Array<{ source_reservation_id: string; reservation_id: string; quantity: string }>;
};

/** Server-owned, caller transaction only. Moving a reservation never consumes it.
 * Its hold is relocated while the canonical TRANSFER posts both physical legs;
 * no other transaction can observe an intermediate unreserved balance. */
export async function routeReceiptLaneDistributionTx(
  tx: Pick<PoolClient, "query">,
  input: { receipt_id: string; article_id: string; lot_id: string; stock_level_id: string;
    stock_batch_id: string; location_id: string; distribution: ReceiptLaneDistribution },
  audit: AuditContext,
): Promise<ReceiptLaneDistribution> {
  const destinations = await getActiveStockLaneDestinationsTx(tx);
  if (!destinations) return input.distribution;
  const mapping = (await tx.query<{ magasin_id: string; emplacement_id: number; unit: string }>(`SELECT
    e.magasin_id::text,e.id::int AS emplacement_id,u.code AS unit
    FROM public.stock_levels sl JOIN public.units u ON u.id=sl.unit_id
    JOIN public.emplacements e ON e.location_id=sl.location_id
    WHERE sl.id=$1::uuid AND sl.article_id=$2::uuid AND sl.location_id=$3::uuid`,
    [input.stock_level_id, input.article_id, input.location_id])).rows[0];
  if (!mapping) throw new HttpError(409, "RECEIPT_LANE_SOURCE_UNMAPPED", "Reliez l'emplacement de réception à son magasin.");
  const routes: Route[] = [];
  const routeId = randomUUID();
  for (const destination of input.distribution.destinations) {
    const target = destinations.find(item => item.lane === destination.lane)!;
    let levelId = input.stock_level_id, batchId = input.stock_batch_id, movementId: string | null = null;
    const reservationTransfers: Route["reservations"] = [];
    if (target.location_id !== input.location_id) {
      const amount = parseCumpDecimal(destination.quantity);
      const quantity = Number(destination.quantity);
      if (!Number.isFinite(quantity) || parseCumpDecimal(String(quantity)) !== amount)
        throw new HttpError(422, "STOCK_TRANSFER_PRECISION_UNSUPPORTED", "La quantité dépasse la précision du transfert stock.");
      const holds = await lockReservationTransfers(tx, input, destination.reservations);
      const held = holds.reduce((sum, item) => sum + parseCumpDecimal(item.quantity), 0n);
      await tx.query("SELECT id FROM public.stock_levels WHERE id=$1::uuid FOR UPDATE", [input.stock_level_id]);
      await tx.query("SELECT id FROM public.stock_batches WHERE id=$1::uuid FOR UPDATE", [input.stock_batch_id]);
      if (held > 0n) {
        const level = await tx.query(`UPDATE public.stock_levels SET qty_reserved=qty_reserved-$2,updated_at=now(),updated_by=$3
          WHERE id=$1::uuid AND qty_reserved>=$2 RETURNING id`, [input.stock_level_id, formatCumpDecimal(held), audit.user_id]);
        const batch = await tx.query("UPDATE public.stock_batches SET qty_reserved=qty_reserved-$2 WHERE id=$1::uuid AND qty_reserved>=$2 RETURNING id",
          [input.stock_batch_id, formatCumpDecimal(held)]);
        if (level.rowCount !== 1 || batch.rowCount !== 1)
          throw new HttpError(409, "RECEIPT_LANE_RESERVATION_CHANGED", "Le solde physique ne correspond plus aux réservations à transférer.");
      }
      const key = `receipt-lane:${input.receipt_id}:${routeId}:${destination.lane}`;
      // The canonical service receives the existing transaction; it must not commit independently.
      const client = tx as PoolClient;
      const created = await repoCreateMovement({ movement_type: "TRANSFER", source_document_type: "PRODUCTION_RECEIPT",
        source_document_id: input.receipt_id, reason_code: "RECEIPT_LANE_ROUTING", notes: "Répartition de la réception de production",
        idempotency_key: `${key}:create`, lines: [{ article_id: input.article_id, lot_id: input.lot_id, qty: quantity,
          unite: mapping.unit, src_magasin_id: mapping.magasin_id, src_emplacement_id: mapping.emplacement_id,
          dst_magasin_id: target.magasin_id, dst_emplacement_id: target.emplacement_id }] },
      audit, { client, trusted_source_flow: true });
      const posted = await repoPostMovement(created.movement.id, {}, audit, `${key}:post`, client);
      if (!posted || posted.movement.status !== "POSTED") throw new Error("RECEIPT_LANE_TRANSFER_NOT_POSTED");
      movementId = posted.movement.id;
      const stock = await readDestinationStock(tx, input, target);
      levelId = stock.stock_level_id; batchId = stock.stock_batch_id;
      for (const hold of holds) {
        const id = await relocateReservation(tx, hold, target, stock, audit.user_id);
        reservationTransfers.push({ source_reservation_id: hold.id, reservation_id: id, quantity: hold.quantity });
      }
      if (held > 0n) {
        const updated = await tx.query(`UPDATE public.stock_levels SET qty_reserved=qty_reserved+$2,updated_at=now(),updated_by=$3
          WHERE id=$1::uuid AND qty_total-qty_reserved-qty_depreciated>=$2 RETURNING id`,
          [levelId, formatCumpDecimal(held), audit.user_id]);
        const batch = await tx.query(`UPDATE public.stock_batches SET qty_reserved=qty_reserved+$2
          WHERE id=$1::uuid AND qty_total-qty_reserved-qty_depreciated>=$2 RETURNING id`, [batchId, formatCumpDecimal(held)]);
        if (updated.rowCount !== 1 || batch.rowCount !== 1)
          throw new HttpError(409, "RECEIPT_LANE_RESERVATION_CHANGED", "Le stock de destination ne couvre plus ses réservations.");
      }
    } else {
      for (const reservation of destination.reservations)
        reservationTransfers.push({ source_reservation_id: reservation.reservation_id, reservation_id: reservation.reservation_id, quantity: reservation.quantity });
    }
    routes.push({ lane: destination.lane, quantity: destination.quantity, source_location_id: input.location_id,
      location_id: target.location_id, location_label: `${target.magasin_code} / ${target.emplacement_code}`,
      stock_level_id: levelId, stock_batch_id: batchId, movement_id: movementId, reservations: reservationTransfers });
  }
  return { ...input.distribution, physical_routing_applied: true, destinations: input.distribution.destinations.map((destination, index) => ({
    ...destination, location_id: routes[index].location_id, location_label: routes[index].location_label, movement_id: routes[index].movement_id,
    source_location_id: input.location_id, stock_level_id: routes[index].stock_level_id, stock_batch_id: routes[index].stock_batch_id,
    reservations: destination.reservations.map(item => ({ ...item,
      source_reservation_id: item.reservation_id,
      reservation_id: routes[index].reservations.find(hold => hold.source_reservation_id === item.reservation_id)!.reservation_id })),
  })) };
}

async function lockReservationTransfers(tx: Pick<PoolClient, "query">,
  input: { article_id: string; lot_id: string; stock_level_id: string; stock_batch_id: string; location_id: string },
  allocations: readonly ReceiptReservationAllocation[],
): Promise<Array<Reservation & { quantity: string }>> {
  const holds: Array<Reservation & { quantity: string }> = [];
  for (const allocation of [...allocations].sort((a, b) => a.reservation_id.localeCompare(b.reservation_id))) {
    const hold = (await tx.query<Reservation>(`SELECT id::text,qty_reserved::text AS quantity,
      qty_consumed::text AS consumed,qty_prepared::text AS prepared,
      commande_ligne_affaire_allocation_id::bigint::int AS allocation_id,of_component_requirement_id::text AS component_id
      FROM public.stock_reservations WHERE id=$1::uuid AND status='ACTIVE' AND article_id=$2::uuid
        AND lot_id=$3::uuid AND stock_level_id=$4::uuid AND stock_batch_id=$5::uuid AND location_id=$6::uuid
        AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE`,
      [allocation.reservation_id, input.article_id, input.lot_id, input.stock_level_id, input.stock_batch_id, input.location_id])).rows[0];
    const quantity = parseCumpDecimal(allocation.quantity);
    if (!hold || quantity <= 0n || parseCumpDecimal(hold.quantity)-parseCumpDecimal(hold.consumed)-parseCumpDecimal(hold.prepared)<quantity
      || (allocation.lane === "DELIVERY" ? !hold.allocation_id || hold.component_id !== null : !hold.component_id || hold.allocation_id !== null))
      throw new HttpError(409, "RECEIPT_LANE_RESERVATION_CHANGED", "Une réservation est déjà préparée, consommée ou rattachée à une autre destination.");
    holds.push({ ...hold, quantity: allocation.quantity });
  }
  return holds;
}

async function readDestinationStock(tx: Pick<PoolClient, "query">,
  input: { article_id: string; lot_id: string; stock_level_id: string }, target: StockLaneDestination,
) {
  const stock = (await tx.query<{ stock_level_id: string; stock_batch_id: string }>(`SELECT sl.id::text AS stock_level_id,sb.id::text AS stock_batch_id
    FROM public.stock_levels sl JOIN public.stock_batches sb ON sb.stock_level_id=sl.id
    WHERE sl.article_id=$1::uuid AND sl.location_id=$2::uuid AND sb.lot_id=$3::uuid
      AND sl.unit_id=(SELECT unit_id FROM public.stock_levels WHERE id=$4::uuid) FOR UPDATE OF sl,sb`,
    [input.article_id, target.location_id, input.lot_id, input.stock_level_id])).rows[0];
  if (!stock) throw new Error("RECEIPT_LANE_DESTINATION_STOCK_MISSING");
  return stock;
}

async function relocateReservation(tx: Pick<PoolClient, "query">, hold: Reservation & { quantity: string },
  destination: StockLaneDestination, stock: { stock_level_id: string; stock_batch_id: string }, actor: number,
): Promise<string> {
  const conflict = hold.allocation_id ? `(commande_ligne_affaire_allocation_id,stock_batch_id)
    WHERE status='ACTIVE' AND commande_ligne_affaire_allocation_id IS NOT NULL AND stock_batch_id IS NOT NULL`
    : `(of_component_requirement_id,stock_batch_id)
    WHERE status='ACTIVE' AND of_component_requirement_id IS NOT NULL AND stock_batch_id IS NOT NULL`;
  const reservation = (await tx.query<{ id: string }>(`INSERT INTO public.stock_reservations(
    article_id,location_id,qty_reserved,source_type,source_id,status,commande_ligne_id,affaire_id,
    livraison_affaire_id,commande_ligne_affaire_allocation_id,of_id,of_component_requirement_id,lot_id,
    stock_level_id,stock_batch_id,source_scope,expires_at,reason,created_by,updated_by)
    SELECT article_id,$2::uuid,$3,source_type,source_id,'ACTIVE',commande_ligne_id,affaire_id,
      livraison_affaire_id,commande_ligne_affaire_allocation_id,of_id,of_component_requirement_id,lot_id,
      $4::uuid,$5::uuid,source_scope,expires_at,'Réservation accompagnant le transfert vers sa piste',$6,$6
    FROM public.stock_reservations WHERE id=$1::uuid
    ON CONFLICT ${conflict} DO UPDATE SET qty_reserved=stock_reservations.qty_reserved+excluded.qty_reserved,
      version=stock_reservations.version+1,updated_at=now(),updated_by=excluded.updated_by RETURNING id::text`,
    [hold.id, destination.location_id, hold.quantity, stock.stock_level_id, stock.stock_batch_id, actor])).rows[0];
  if (!reservation) throw new Error("RECEIPT_LANE_DESTINATION_RESERVATION_MISSING");
  // Keep a released historical reservation's positive quantity and evidence.
  // A partial relocation preserves the old consumed/prepared quantities in place.
  await tx.query(`UPDATE public.stock_reservations SET
    status=CASE WHEN qty_reserved=$2 THEN 'RELEASED' WHEN qty_reserved-$2=qty_consumed THEN 'CONSUMED' ELSE 'ACTIVE' END,
    qty_reserved=CASE WHEN qty_reserved=$2 THEN qty_reserved ELSE qty_reserved-$2 END,
    released_at=CASE WHEN qty_reserved=$2 THEN now() ELSE released_at END,
    released_by=CASE WHEN qty_reserved=$2 THEN $3 ELSE released_by END,
    release_reason=CASE WHEN qty_reserved=$2 THEN 'Transfert vers la piste de destination' ELSE release_reason END,
    version=version+1,updated_at=now(),updated_by=$3 WHERE id=$1::uuid AND status='ACTIVE'`, [hold.id, hold.quantity, actor]);
  return reservation.id;
}
