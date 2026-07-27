\set ON_ERROR_STOP on

SELECT current_database() = 'cerp_test' AS is_test_database;

SELECT
  numeric_precision = 18 AS precision_is_18,
  numeric_scale = 6 AS scale_is_6
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'stock_movement_lines'
  AND column_name = 'qty';

SELECT COUNT(*) = 0 AS opening_lines_match_posted_headers
FROM public.stock_movement_lines l
JOIN public.stock_movements m ON m.id = l.movement_id
WHERE m.status = 'POSTED'
  AND m.source_document_type = 'CLIPPER_STOCK_OPENING'
  AND l.qty IS DISTINCT FROM m.qty;

SELECT COUNT(*) = 0 AS opening_headers_match_stock_levels
FROM public.stock_movements m
JOIN public.stock_levels sl ON sl.id = m.stock_level_id
WHERE m.status = 'POSTED'
  AND m.source_document_type = 'CLIPPER_STOCK_OPENING'
  AND sl.qty_total IS DISTINCT FROM m.qty;

SELECT
  COUNT(*) AS precision_repair_events,
  COUNT(*) FILTER (
    WHERE old_values ? 'line_qty'
      AND new_values ? 'line_qty'
  ) = COUNT(*) AS all_repairs_are_audited
FROM public.stock_movement_event_log
WHERE event_type = 'PRECISION_RECONCILED_198';
