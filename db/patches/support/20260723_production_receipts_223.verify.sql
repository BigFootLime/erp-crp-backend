\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#223 verification is restricted to cerp_test, got %', current_database();
  END IF;
  IF to_regclass('public.of_receipts') IS NULL
     OR to_regclass('public.v_stock_lot_availability') IS NULL THEN
    RAISE EXCEPTION '#223 ledger or availability view is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_receipts_actor_key_uq'
      AND conrelid = 'public.of_receipts'::regclass
  ) THEN
    RAISE EXCEPTION '#223 actor/idempotency uniqueness is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_protect_of_receipt'
      AND tgrelid = 'public.of_receipts'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '#223 immutable-ledger trigger is missing';
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM public.of_receipts) AS receipts,
  (SELECT count(*) FROM public.of_receipts WHERE result_payload IS NULL) AS incomplete_receipts,
  (SELECT count(*) FROM public.stock_batches WHERE lot_id IS NOT NULL) AS linked_batches,
  (SELECT count(*) FROM public.stock_reservations WHERE lot_id IS NOT NULL AND stock_batch_id IS NULL) AS incomplete_lot_reservations,
  (SELECT count(*) FROM public.v_stock_lot_availability WHERE qty_available < 0) AS negative_available_rows;

SELECT
  c.relname,
  c.relkind,
  pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
WHERE c.oid IN ('public.of_receipts'::regclass, 'public.v_stock_lot_availability'::regclass)
ORDER BY c.relname;

SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    THEN has_table_privilege('cerp_app', 'public.of_receipts', 'SELECT,INSERT')
    ELSE NULL
  END AS cerp_app_receipt_runtime_access,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    THEN has_table_privilege('cerp_app', 'public.v_stock_lot_availability', 'SELECT')
    ELSE NULL
  END AS cerp_app_availability_read_access;
