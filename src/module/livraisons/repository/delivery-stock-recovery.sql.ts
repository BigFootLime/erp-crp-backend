export const DELIVERY_RECOVERY_CONTEXT_SQL = `
SELECT allocation.id::int AS allocation_id, allocation.allocation_version,
  allocation.commande_id::int, allocation.commande_ligne_id::int, allocation.livraison_affaire_id::int,
  allocation.qty_ordered::text AS ordered, allocation.qty_delivered::text AS delivered_projection,
  line.quantite::text AS line_ordered, line.article_id::text AS article_id,
  line.piece_technique_version_id::text AS technical_version_id, line.unite AS unit,
  article.code AS article_code, COALESCE(line.designation,article.designation) AS designation,
  technical.indice, piece.client_id::text AS piece_client_id,
  command.client_id::text, command.numero AS commande_numero,
  command.code_client AS customer_order_reference, command.order_type, command.statut::text AS command_status,
  customer.company_name AS client_name, customer.client_code,
  affair.reference AS affaire_reference, affair.statut::text AS affair_status,
  affair.delivery_readiness_state, promise.initial_due_date::text AS ar_due_date,
  COALESCE((SELECT sum(a.quantite) FROM public.bon_livraison_ligne_allocations a
    JOIN public.bon_livraison_ligne bl_line ON bl_line.id=a.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
    WHERE a.commande_ligne_affaire_allocation_id=allocation.id AND bl.statut IN('SHIPPED','DELIVERED')),0)::text AS shipped,
  COALESCE((SELECT sum(r.qty_reserved-r.qty_consumed) FROM public.stock_reservations r
    WHERE r.commande_ligne_affaire_allocation_id=allocation.id AND r.status='ACTIVE'),0)::text AS reserved,
  COALESCE((SELECT sum(a.quantite-a.qty_consumed) FROM public.bon_livraison_ligne_allocations a
    JOIN public.bon_livraison_ligne bl_line ON bl_line.id=a.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
    WHERE a.commande_ligne_affaire_allocation_id=allocation.id AND a.reservation_id IS NULL
      AND bl.statut IN('DRAFT','READY')),0)::text AS unreserved_prepared,
  EXISTS(SELECT 1 FROM public.bon_livraison_ligne_allocations a
    JOIN public.bon_livraison_ligne bl_line ON bl_line.id=a.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
    LEFT JOIN public.stock_reservations r ON r.id=a.reservation_id
    WHERE a.commande_ligne_affaire_allocation_id=allocation.id AND bl.statut IN('DRAFT','READY')
      AND a.reservation_id IS NOT NULL AND (r.status IS DISTINCT FROM 'ACTIVE'
        OR r.commande_ligne_affaire_allocation_id IS DISTINCT FROM allocation.id)) AS invalid_prepared,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'version',r.version,
      'quantity',r.qty_reserved,'consumed',r.qty_consumed,'prepared',r.qty_prepared) ORDER BY r.id),'[]')
    FROM public.stock_reservations r WHERE r.commande_ligne_affaire_allocation_id=allocation.id) AS reservation_state
FROM public.commande_ligne_affaire_allocation allocation
JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=allocation.commande_id
JOIN public.commande_client command ON command.id=allocation.commande_id
JOIN public.clients customer ON customer.client_id=command.client_id
JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
JOIN public.articles article ON article.id=line.article_id AND (allocation.article_ref_id IS NULL OR allocation.article_ref_id=article.id)
JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id AND technical.piece_technique_id=article.piece_technique_id
JOIN public.pieces_techniques piece ON piece.id=technical.piece_technique_id
LEFT JOIN public.delivery_promise_roots promise ON promise.allocation_id=allocation.id
WHERE allocation.id=$1::bigint`;

// Ordinary recovery cannot take a delivery/assembly commitment, even when its
// physical balance happens to be unreserved. Urgent borrowing is a different flow.
export const DELIVERY_RECOVERY_STOCK_SQL = `
SELECT batch.id::text AS stock_batch_id, level.id::text AS stock_level_id,
  level.location_id::text, lot.id::text AS lot_id, lot.lot_code, lot.lot_status::text,
  lot.expiry_at::text, lane.lane, m.code AS magasin_code,e.code AS emplacement_code,
  CASE WHEN lot.origin_stock_scope='OLD' THEN 'OLD'
    ELSE COALESCE(lot.source_scope,lot.stock_scope,warehouse.stock_scope,'NEW') END AS source_scope,
  GREATEST(batch.qty_total-batch.qty_reserved-batch.qty_depreciated,0)::text AS batch_available,
  GREATEST(level.qty_total-level.qty_reserved-level.qty_depreciated,0)::text AS level_available,
  lot.piece_technique_version_id::text AS stock_version_id,
  EXISTS(SELECT 1 FROM public.v_technical_stock_compatibility_832 compatibility
    WHERE compatibility.stock_version_id=lot.piece_technique_version_id
      AND compatibility.target_version_id=$2::uuid) AS version_compatible,
  EXISTS(SELECT 1 FROM public.old_stock_document_references d WHERE d.lot_id=lot.id) AS old_documents
FROM public.stock_batches batch
JOIN public.stock_levels level ON level.id=batch.stock_level_id
JOIN public.lots lot ON lot.id=batch.lot_id AND lot.article_id=level.article_id
JOIN public.warehouses warehouse ON warehouse.id=level.warehouse_id
JOIN public.locations location ON location.id=level.location_id AND location.warehouse_id=level.warehouse_id
JOIN public.emplacements e ON e.location_id=level.location_id
JOIN public.magasins m ON m.id=e.magasin_id
LEFT JOIN public.stock_lane_locations lane ON lane.location_id=level.location_id
WHERE level.article_id=$1::uuid AND level.managed_in_stock AND m.is_active AND e.is_active
  AND e.location_type='STORAGE' AND NOT e.is_scrap AND e.allow_outbound
  AND batch.qty_total-batch.qty_reserved-batch.qty_depreciated>0
  AND level.qty_total-level.qty_reserved-level.qty_depreciated>0
  AND (lane.lane='FREE' OR ($3::boolean AND lane.lane IS NULL))
ORDER BY COALESCE(lot.received_at,lot.manufactured_at,lot.created_at::date),lot.created_at,lot.id,level.id,batch.id
LIMIT 200`;
