-- Read-only post-deployment verification for
-- 20260826_commandes_stock_reservations_livraisons_atomic.sql.
-- Run with psql after the patch; it does not alter data.

SELECT
  relname AS relation,
  to_regclass(format('public.%I', relname)) IS NOT NULL AS exists
FROM (VALUES
  ('of_receipts'),
  ('stock_reservation_verifications'),
  ('stock_reservation_corrections'),
  ('bon_livraison_ship_receipts'),
  ('bon_livraison_prepare_receipts'),
  ('delivery_outbox')
) AS required(relname)
ORDER BY relname;

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'lots' AND column_name = 'source_scope')
    OR (table_name = 'commande_ligne_affaire_allocation' AND column_name IN (
      'qty_produced', 'qty_stocked', 'qty_delivered', 'qty_remaining',
      'allocation_version', 'delivery_status'
    ))
    OR (table_name = 'stock_reservations' AND column_name IN (
      'commande_ligne_affaire_allocation_id', 'livraison_affaire_id', 'lot_id',
      'stock_level_id', 'stock_batch_id', 'of_id', 'source_scope',
      'qty_consumed', 'qty_prepared', 'version', 'consumed_at', 'released_at', 'release_reason'
    ))
    OR (table_name = 'of_receipts' AND column_name IN ('qty_ok', 'qty_scrap', 'qty_rework', 'quality_status'))
    OR (table_name = 'bon_livraison' AND column_name IN (
      'shipping_version', 'shipping_preview_hash', 'shipped_at'
    ))
    OR (table_name = 'bon_livraison_ligne_allocations' AND column_name IN (
      'reservation_id', 'magasin_id', 'emplacement_id', 'location_id', 'stock_level_id', 'stock_batch_id',
      'commande_ligne_affaire_allocation_id', 'verified_at',
      'verification_snapshot', 'qty_consumed'
    ))
    OR (table_name = 'delivery_outbox' AND column_name IN ('requested_at', 'published_at', 'attempts'))
  )
ORDER BY table_name, column_name;

SELECT conrelid::regclass AS relation, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname IN (
  'lots_source_scope_chk',
  'commande_ligne_affaire_allocation_progress_chk',
  'commande_ligne_affaire_allocation_delivery_status_chk',
  'stock_reservations_source_scope_chk',
  'stock_reservations_status_v2_chk',
  'stock_reservations_consumed_chk',
  'stock_reservations_prepared_chk',
  'of_receipts_qty_scrap_chk',
  'of_receipts_qty_rework_chk',
  'of_receipts_actor_key_uniq',
  'bon_livraison_ship_receipts_actor_key_uniq',
  'bon_livraison_prepare_receipts_actor_key_uniq',
  'stock_reservation_corrections_actor_key_uniq'
)
ORDER BY relation::text, conname;

SELECT indexrelid::regclass AS index_name, indrelid::regclass AS on_relation
FROM pg_index
WHERE indexrelid::regclass::text IN (
  'stock_reservations_active_allocation_batch_uniq',
  'stock_reservations_allocation_idx',
  'stock_reservations_lot_batch_idx',
  'lots_source_scope_fifo_idx',
  'stock_reservation_verifications_reservation_idx',
  'stock_reservation_corrections_reservation_idx',
  'bon_livraison_ship_receipts_bl_idx',
  'bon_livraison_prepare_receipts_bl_idx'
)
ORDER BY index_name::text;

-- These should return zero rows.  They reveal a legacy data anomaly that must
-- be corrected through audited movements/release operations, never by deleting
-- reservation or receipt rows.
SELECT id, stock_batch_id, qty_reserved, qty_consumed, qty_prepared
FROM public.stock_reservations
WHERE qty_consumed < 0
   OR qty_prepared < 0
   OR qty_consumed + qty_prepared > qty_reserved;

-- The migration deliberately stops before adding the unique index if this is
-- non-empty; keep it here as an operational post-check as well.
SELECT
  commande_ligne_affaire_allocation_id,
  stock_batch_id,
  COUNT(*) AS active_rows,
  array_agg(id::text ORDER BY id) AS reservation_ids
FROM public.stock_reservations
WHERE status = 'ACTIVE'
  AND commande_ligne_affaire_allocation_id IS NOT NULL
  AND stock_batch_id IS NOT NULL
GROUP BY commande_ligne_affaire_allocation_id, stock_batch_id
HAVING COUNT(*) > 1;

SELECT id, qty_ordered, qty_delivered, delivery_status
FROM public.commande_ligne_affaire_allocation
WHERE qty_delivered < 0
   OR qty_delivered > qty_ordered
   OR delivery_status NOT IN ('A_PREPARER', 'PARTIELLEMENT_LIVREE', 'LIVREE');
