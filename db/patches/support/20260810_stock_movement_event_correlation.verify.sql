-- Read-only post-migration verification for SOL-05 stock movement audit correlation.
-- Expected: every boolean is true.

SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movement_event_log'
      AND column_name = 'correlation_id'
      AND data_type = 'uuid'
  ) AS has_correlation_id,
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'stock_movement_event_log'
      AND indexname = 'stock_movement_event_log_correlation_idx'
  ) AS has_correlation_index,
  NOT EXISTS (
    SELECT 1
    FROM public.stock_movement_event_log
    WHERE correlation_id IS NOT NULL
      AND correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) AS correlation_values_are_valid;
