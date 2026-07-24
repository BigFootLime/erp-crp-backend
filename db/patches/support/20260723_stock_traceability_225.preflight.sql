\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#225 preflight is restricted to cerp_test, got %', current_database();
  END IF;
END $$;

SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;

SELECT prerequisite, present
FROM (
  VALUES
    ('articles', to_regclass('public.articles') IS NOT NULL),
    ('users', to_regclass('public.users') IS NOT NULL),
    ('units', to_regclass('public.units') IS NOT NULL),
    ('warehouses', to_regclass('public.warehouses') IS NOT NULL),
    ('locations', to_regclass('public.locations') IS NOT NULL),
    ('magasins', to_regclass('public.magasins') IS NOT NULL),
    ('emplacements', to_regclass('public.emplacements') IS NOT NULL),
    ('lots', to_regclass('public.lots') IS NOT NULL),
    ('stock_levels', to_regclass('public.stock_levels') IS NOT NULL),
    ('stock_batches', to_regclass('public.stock_batches') IS NOT NULL),
    ('stock_movements', to_regclass('public.stock_movements') IS NOT NULL),
    ('stock_movement_lines', to_regclass('public.stock_movement_lines') IS NOT NULL),
    ('stock_movement_event_log', to_regclass('public.stock_movement_event_log') IS NOT NULL),
    ('stock_reservations', to_regclass('public.stock_reservations') IS NOT NULL),
    ('stock_inventory_sessions', to_regclass('public.stock_inventory_sessions') IS NOT NULL),
    ('stock_inventory_lines', to_regclass('public.stock_inventory_lines') IS NOT NULL),
    ('stock_inventory_session_movements', to_regclass('public.stock_inventory_session_movements') IS NOT NULL),
    ('commande_ligne', to_regclass('public.commande_ligne') IS NOT NULL),
    ('ordres_fabrication', to_regclass('public.ordres_fabrication') IS NOT NULL),
    ('bon_livraison_ligne', to_regclass('public.bon_livraison_ligne') IS NOT NULL),
    ('affaire', to_regclass('public.affaire') IS NOT NULL)
) AS checks(prerequisite, present)
ORDER BY prerequisite;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'stock_movements' AND column_name IN (
      'id',
      'movement_type',
      'status',
      'article_id',
      'stock_level_id',
      'stock_batch_id',
      'qty',
      'user_id'
    ))
    OR (table_name = 'stock_movement_lines' AND column_name IN ('id', 'movement_id'))
    OR (table_name = 'stock_movement_event_log' AND column_name IN ('id', 'stock_movement_id', 'event_type'))
    OR (table_name = 'stock_levels' AND column_name IN (
      'id',
      'qty_total',
      'qty_reserved',
      'qty_depreciated',
      'updated_at'
    ))
    OR (table_name = 'stock_batches' AND column_name IN ('id', 'lot_id', 'qty_total', 'qty_reserved', 'qty_depreciated'))
    OR (table_name = 'stock_inventory_sessions' AND column_name IN ('id', 'status', 'started_at'))
    OR (table_name = 'stock_inventory_lines' AND column_name IN (
      'id',
      'session_id',
      'article_id',
      'magasin_id',
      'emplacement_id',
      'lot_id'
    ))
    OR (table_name = 'stock_inventory_session_movements' AND column_name IN (
      'session_id',
      'stock_movement_id'
    ))
    OR (table_name = 'stock_reservations' AND column_name IN ('lot_id', 'stock_batch_id'))
  )
ORDER BY table_name, ordinal_position;

DO $$
DECLARE
  required_columns_count integer;
BEGIN
  SELECT count(*)::integer
  INTO required_columns_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'stock_movements' AND column_name IN (
        'id',
        'movement_type',
        'status',
        'article_id',
        'stock_level_id',
        'stock_batch_id',
        'qty',
        'user_id'
      ))
      OR (table_name = 'stock_movement_lines' AND column_name IN ('id', 'movement_id'))
      OR (table_name = 'stock_movement_event_log' AND column_name IN ('id', 'stock_movement_id', 'event_type'))
      OR (table_name = 'stock_levels' AND column_name IN (
        'id',
        'qty_total',
        'qty_reserved',
        'qty_depreciated',
        'updated_at'
      ))
      OR (table_name = 'stock_batches' AND column_name IN ('id', 'lot_id', 'qty_total', 'qty_reserved', 'qty_depreciated'))
      OR (table_name = 'stock_inventory_sessions' AND column_name IN ('id', 'status', 'started_at'))
      OR (table_name = 'stock_inventory_lines' AND column_name IN (
        'id',
        'session_id',
        'article_id',
        'magasin_id',
        'emplacement_id',
        'lot_id'
      ))
      OR (table_name = 'stock_inventory_session_movements' AND column_name IN (
        'session_id',
        'stock_movement_id'
      ))
      OR (table_name = 'stock_reservations' AND column_name IN ('lot_id', 'stock_batch_id'))
    );

  IF required_columns_count <> 36 THEN
    RAISE EXCEPTION '#225 preflight found %/36 required stock columns', required_columns_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movements'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION '#225 requires the canonical UUID stock movement spine';
  END IF;
END $$;

SELECT status, count(*) AS rows_count
FROM public.stock_reservations
GROUP BY status
ORDER BY status;

SELECT status::text, count(*) AS rows_count
FROM public.stock_movements
GROUP BY status
ORDER BY status;

SELECT
  source_type,
  source_id,
  article_id,
  location_id,
  lot_id,
  count(*) AS active_duplicates
FROM public.stock_reservations
WHERE status = 'ACTIVE'
GROUP BY source_type, source_id, article_id, location_id, lot_id
HAVING count(*) > 1
ORDER BY active_duplicates DESC, source_type, source_id;

SELECT
  count(*) FILTER (WHERE qty_total < 0) AS negative_total_levels,
  count(*) FILTER (WHERE qty_reserved < 0) AS negative_reserved_levels,
  count(*) FILTER (WHERE qty_depreciated < 0) AS negative_depreciated_levels,
  count(*) FILTER (WHERE qty_reserved + qty_depreciated > qty_total) AS overcommitted_levels
FROM public.stock_levels;

SELECT
  count(*) FILTER (WHERE qty_total < 0) AS negative_total_batches,
  count(*) FILTER (WHERE qty_reserved < 0) AS negative_reserved_batches,
  count(*) FILTER (WHERE qty_depreciated < 0) AS negative_depreciated_batches,
  count(*) FILTER (WHERE qty_reserved + qty_depreciated > qty_total) AS overcommitted_batches
FROM public.stock_batches;

SELECT
  count(*) FILTER (WHERE lot_id IS NULL) AS reservations_without_lot,
  count(*) FILTER (WHERE stock_batch_id IS NULL) AS reservations_without_batch,
  count(*) FILTER (
    WHERE lot_id IS NOT NULL AND stock_batch_id IS NULL
  ) AS lot_reservations_without_batch
FROM public.stock_reservations;

SELECT
  count(*) FILTER (
    WHERE reservation.source_type = 'COMMANDE_LIGNE'
      AND reservation.source_id !~ '^[0-9]+$'
  ) AS invalid_commande_ligne_source_ids,
  count(*) FILTER (
    WHERE reservation.source_type = 'COMMANDE_LIGNE'
      AND reservation.source_id ~ '^[0-9]+$'
      AND NOT EXISTS (
        SELECT 1
        FROM public.commande_ligne
        WHERE id = CASE
          WHEN reservation.source_id ~ '^[0-9]+$'
            THEN reservation.source_id::bigint
          ELSE NULL
        END
      )
  ) AS missing_commande_ligne_sources,
  count(*) FILTER (
    WHERE reservation.source_type NOT IN (
      'COMMANDE_LIGNE',
      'OF',
      'BON_LIVRAISON_LIGNE',
      'AFFAIRE'
    )
  ) AS legacy_source_types_to_review
FROM public.stock_reservations reservation;
