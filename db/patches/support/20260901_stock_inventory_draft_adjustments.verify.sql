\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_inventory_session_movements'
      AND column_name = 'snapshot_line_id'
      AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'Inventory draft-adjustment verification failed: snapshot_line_id is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stock_inventory_session_movements_snapshot_line_fkey'
      AND conrelid = 'public.stock_inventory_session_movements'::regclass
  ) OR to_regclass('public.stock_inventory_session_movements_snapshot_idx') IS NULL THEN
    RAISE EXCEPTION 'Inventory draft-adjustment verification failed: FK or index is missing';
  END IF;
END
$$;

COMMIT;
