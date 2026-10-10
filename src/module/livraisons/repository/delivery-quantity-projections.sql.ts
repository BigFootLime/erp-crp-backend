/** Read-only projections; aliases match the delivery and reservation readers. */
export const remainingReservedQuantitySql = `GREATEST(0, r.qty_reserved - r.qty_consumed)`

/**
 * One order-affair allocation may span several lots or BL lines. Subtract the
 * whole preparation on this BL exactly once from the actual unshipped demand.
 * Shipped/cancelled BLs show the current real remainder, without subtracting it
 * again. qty_remaining is a maintained cache and can still be zero on creation.
 */
export const deliveryRemainderQuantitySql = `
  CASE WHEN commande_allocation.id IS NULL THEN NULL
  ELSE GREATEST(0,
    commande_allocation.qty_ordered - commande_allocation.qty_delivered
    - CASE WHEN delivery.statut IN ('DRAFT', 'READY') THEN COALESCE((
        SELECT SUM(prepared.quantite)
        FROM public.bon_livraison_ligne_allocations prepared
        JOIN public.bon_livraison_ligne prepared_line
          ON prepared_line.id = prepared.bon_livraison_ligne_id
        WHERE prepared_line.bon_livraison_id = delivery.id
          AND prepared.commande_ligne_affaire_allocation_id = commande_allocation.id
      ), 0) ELSE 0 END
  ) END
`
