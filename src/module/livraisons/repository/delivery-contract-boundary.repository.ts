import type { PoolClient } from "pg"
import { HttpError } from "../../../utils/httpError"
import { deliveryContractBoundary, type DeliveryContractOrder } from "../domain/delivery-contract-boundary"

type Queryer = Pick<PoolClient, "query">

export async function readDeliveryContractBoundary(tx: Queryer, deliveryId: string) {
  const header = (await tx.query<{client_id:string}>(
    `SELECT client_id::text FROM public.bon_livraison WHERE id=$1::uuid`, [deliveryId],
  )).rows[0]
  if (!header) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "BL introuvable")
  // Resolve actual line/allocation identities, including multi-order BLs with no header order.
  // Immutable call bindings require no extra lock after stock/reservation row locks.
  const sources = await tx.query<DeliveryContractOrder & { has_unbound_lines:boolean }>(`
    WITH delivery_lines AS (
      SELECT line.id, line.commande_ligne_id, command_line.commande_id
      FROM public.bon_livraison_ligne line
      LEFT JOIN public.commande_ligne command_line ON command_line.id=line.commande_ligne_id
      WHERE line.bon_livraison_id=$1::uuid
    ), source_ids AS (
      SELECT commande_id FROM public.bon_livraison WHERE id=$1::uuid
      UNION SELECT commande_id FROM delivery_lines
      UNION
      SELECT source.commande_id FROM delivery_lines line
      JOIN public.bon_livraison_ligne_allocations allocation ON allocation.bon_livraison_ligne_id=line.id
      JOIN public.commande_ligne_affaire_allocation source ON source.id=allocation.commande_ligne_affaire_allocation_id
      UNION
      SELECT source.commande_id FROM delivery_lines line
      JOIN public.bon_livraison_ligne_allocations allocation ON allocation.bon_livraison_ligne_id=line.id
      JOIN public.stock_reservations reservation ON reservation.id=allocation.reservation_id
      JOIN public.commande_ligne_affaire_allocation source ON source.id=reservation.commande_ligne_affaire_allocation_id
    )
    SELECT command.id::text AS commande_id, command.client_id::text AS client_id,
      command.order_type, call.contract_id::text AS contract_id,
      EXISTS(SELECT 1 FROM delivery_lines WHERE commande_id IS NULL) AS has_unbound_lines
    FROM source_ids source JOIN public.commande_client command ON command.id=source.commande_id
    LEFT JOIN public.client_contract_calls call ON call.commande_id=command.id
    ORDER BY command.id
  `, [deliveryId])
  return deliveryContractBoundary({clientId:header.client_id, orders:sources.rows,
    hasUnboundLines:sources.rows.some(row=>row.has_unbound_lines)})
}

export async function assertDeliveryContractBoundary(tx: Queryer, deliveryId: string): Promise<void> {
  const {blocker}=await readDeliveryContractBoundary(tx,deliveryId)
  if (blocker) throw new HttpError(409,blocker.code,blocker.message)
}
