-- Guarded rollback for SOL-05 stock movement audit correlation.
-- Human approval and restore validation against the pre-migration backup are mandatory.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.stock_movement_event_log
    WHERE correlation_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Correlated stock movement audit evidence exists; roll back application code and preserve the column';
  END IF;
END $$;

DROP INDEX IF EXISTS public.stock_movement_event_log_correlation_idx;

ALTER TABLE public.stock_movement_event_log
  DROP COLUMN IF EXISTS correlation_id;

COMMIT;
