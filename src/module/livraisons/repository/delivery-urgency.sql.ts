/** Same-client delivery reservations only; free stock is calculated by the canonical recovery preview. */
export const DELIVERY_URGENCY_DONORS_SQL = `
SELECT reservation.id::text AS reservation_id, reservation.version AS reservation_version,
  allocation.id::int AS allocation_id, allocation.allocation_version,
  allocation.commande_id::int, allocation.commande_ligne_id::int, allocation.livraison_affaire_id::int,
  command.client_id::text, command.numero AS commande_numero, command.code_client AS customer_order_reference,
  affair.reference AS affaire_reference, line.article_id::text AS article_id, lane.lane,
  technical.piece_technique_id::text, technical.id::text AS technical_version_id,
  promise.initial_due_date::text AS initial_ar_due_date, promise.version AS promise_version,
  (SELECT min(part.due_date)::text FROM public.delivery_promise_parts part
    WHERE part.root_id=promise.id AND part.retired_at IS NULL
      AND part.quantity>COALESCE((SELECT sum(shipped.quantity) FROM public.delivery_promise_shipments shipped
        WHERE shipped.part_id=part.id),0)) AS protected_due_date,
  (reservation.qty_reserved-reservation.qty_consumed)::text AS reservation_remaining,
  COALESCE((SELECT sum(source.quantity) FROM public.delivery_urgency_sources source
    JOIN public.delivery_urgency_recoveries recovery ON recovery.id=source.recovery_id
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    WHERE source.donor_reservation_id=reservation.id AND request.status IN('WAITING_PLANNER','APPROVED')
      AND ($5::uuid IS NULL OR request.id<>$5::uuid)),0)::text AS pending_quantity,
  GREATEST(reservation.qty_prepared,COALESCE((SELECT sum(bl_alloc.quantite-bl_alloc.qty_consumed)
    FROM public.bon_livraison_ligne_allocations bl_alloc
    JOIN public.bon_livraison_ligne bl_line ON bl_line.id=bl_alloc.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
    WHERE bl_alloc.reservation_id=reservation.id AND bl.statut IN('DRAFT','READY')),0))::text AS prepared_quantity,
  batch.id::text AS stock_batch_id, level.id::text AS stock_level_id,
  batch.qty_total::text AS batch_total, batch.qty_reserved::text AS batch_reserved,
  batch.qty_depreciated::text AS batch_depreciated, level.qty_total::text AS level_total,
  level.qty_reserved::text AS level_reserved, level.qty_depreciated::text AS level_depreciated,
  lot.id::text AS lot_id, lot.lot_code, lot.lot_status::text, lot.expiry_at::text,
  CASE WHEN lot.origin_stock_scope='OLD' THEN 'OLD'
    ELSE COALESCE(lot.source_scope,lot.stock_scope,warehouse.stock_scope,'NEW') END AS source_scope,
  lot.piece_technique_version_id::text AS stock_version_id,
  EXISTS(SELECT 1 FROM public.v_technical_stock_compatibility_832 compatibility
    WHERE compatibility.stock_version_id=lot.piece_technique_version_id
      AND compatibility.target_version_id=$3::uuid) AS version_compatible,
  EXISTS(SELECT 1 FROM public.old_stock_document_references document WHERE document.lot_id=lot.id) AS old_documents
FROM public.stock_reservations reservation
JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=reservation.commande_ligne_affaire_allocation_id
  AND allocation.commande_ligne_id=reservation.commande_ligne_id AND allocation.livraison_affaire_id=reservation.livraison_affaire_id
JOIN public.commande_client command ON command.id=allocation.commande_id
JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=command.id
JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id
JOIN public.pieces_techniques piece ON piece.id=technical.piece_technique_id
  AND piece.article_id=line.article_id AND piece.client_id::text=command.client_id::text AND piece.deleted_at IS NULL
JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
JOIN public.delivery_promise_roots promise ON promise.allocation_id=allocation.id
JOIN public.stock_batches batch ON batch.id=reservation.stock_batch_id AND batch.lot_id=reservation.lot_id
JOIN public.stock_levels level ON level.id=batch.stock_level_id AND level.id=reservation.stock_level_id
  AND level.article_id=reservation.article_id AND level.location_id=reservation.location_id
JOIN public.stock_lane_locations lane ON lane.location_id=level.location_id AND lane.lane='DELIVERY'
JOIN public.lots lot ON lot.id=batch.lot_id AND lot.article_id=level.article_id
JOIN public.locations location ON location.id=level.location_id AND location.warehouse_id=level.warehouse_id
JOIN public.warehouses warehouse ON warehouse.id=level.warehouse_id
JOIN public.emplacements emplacement ON emplacement.location_id=location.id
JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
WHERE command.client_id::text=$1 AND level.article_id=$2::uuid AND line.article_id=$2::uuid
  AND ($6::uuid[] IS NULL OR reservation.id=ANY($6::uuid[]))
  AND allocation.id<>$4::bigint AND command.order_type<>'INTERNE'
  AND affair.statut::text NOT IN('ANNULE','ANNULEE','CANCELLED')
  AND COALESCE((SELECT history.nouveau_statut::text FROM public.commande_historique history
    WHERE history.commande_id=command.id ORDER BY history.date_action DESC,history.id DESC LIMIT 1),'BROUILLON')
    NOT IN('ANNULE','ANNULEE','CANCELLED')
  AND reservation.status='ACTIVE' AND (reservation.expires_at IS NULL OR reservation.expires_at>now())
  AND reservation.qty_reserved>reservation.qty_consumed AND level.managed_in_stock
  AND magasin.is_active AND emplacement.is_active AND emplacement.allow_outbound
  AND emplacement.location_type='STORAGE' AND NOT emplacement.is_scrap
ORDER BY protected_due_date DESC NULLS LAST,reservation.id
LIMIT 201`;
