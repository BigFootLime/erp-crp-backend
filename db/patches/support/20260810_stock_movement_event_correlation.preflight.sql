-- Read-only preflight for SOL-05 stock movement audit correlation.
-- Expected: every boolean is true. Run before the table-level backup.

SELECT
  to_regclass('public.stock_movement_event_log') IS NOT NULL AS has_event_log,
  to_regclass('public.stock_movements') IS NOT NULL AS has_stock_movements,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movement_event_log'
      AND column_name = 'stock_movement_id'
      AND data_type = 'uuid'
  ) AS has_uuid_movement_reference,
  NOT EXISTS (
    SELECT 1
    FROM public.stock_movement_event_log event
    LEFT JOIN public.stock_movements movement ON movement.id = event.stock_movement_id
    WHERE movement.id IS NULL
  ) AS movement_references_are_valid;
