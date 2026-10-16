import type { PoolClient } from "pg"

import { HttpError } from "../../../utils/httpError"

type Queryable = Pick<PoolClient, "query">

export type DeliveryAcknowledgementSource = {
  commande_id: string
  order_type: string | null
  ar_sent_at: string | null
}

export function hasMissingCustomerAcknowledgement(sources: readonly DeliveryAcknowledgementSource[]): boolean {
  return sources.some(source => String(source.order_type ?? "").toUpperCase() !== "INTERNE" && !source.ar_sent_at)
}

export const customerAcknowledgementBlocker = {
  code: "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED",
  message: "L’AR client doit être envoyé avant la livraison et la sortie physique du stock.",
} as const

/** Canonical allocation sources win; the legacy header is a fallback only. */
export async function readDeliveryCustomerAcknowledgementSources(client: Queryable, bonLivraisonId: string): Promise<DeliveryAcknowledgementSource[]> {
  const result = await client.query<DeliveryAcknowledgementSource>(`
    WITH canonical_source_orders AS (
      SELECT DISTINCT source.commande_id
      FROM public.bon_livraison_ligne line
      JOIN public.bon_livraison_ligne_allocations allocated ON allocated.bon_livraison_ligne_id = line.id
      LEFT JOIN public.stock_reservations reservation ON reservation.id = allocated.reservation_id
      JOIN public.commande_ligne_affaire_allocation source ON source.id = COALESCE(
        allocated.commande_ligne_affaire_allocation_id,
        reservation.commande_ligne_affaire_allocation_id
      )
      WHERE line.bon_livraison_id = $1::uuid
    ), source_orders AS (
      SELECT commande_id FROM canonical_source_orders
      UNION ALL
      SELECT delivery.commande_id
      FROM public.bon_livraison delivery
      WHERE delivery.id = $1::uuid
        AND delivery.commande_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM canonical_source_orders)
    )
    SELECT command.id::text AS commande_id, command.order_type, command.ar_sent_at::text AS ar_sent_at
    FROM source_orders source
    JOIN public.commande_client command ON command.id = source.commande_id
    ORDER BY command.id
  `, [bonLivraisonId])
  return result.rows
}

export async function assertDeliveryCustomerAcknowledgement(client: Queryable, bonLivraisonId: string): Promise<void> {
  if (!hasMissingCustomerAcknowledgement(await readDeliveryCustomerAcknowledgementSources(client, bonLivraisonId))) return
  throw new HttpError(409, customerAcknowledgementBlocker.code, customerAcknowledgementBlocker.message)
}
