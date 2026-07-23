\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#225 verification is restricted to cerp_test, got %', current_database();
  END IF;

  IF to_regclass('public.stock_command_receipts') IS NULL
     OR to_regclass('public.stock_reservation_event_log') IS NULL
     OR to_regclass('public.stock_lot_event_log') IS NULL
     OR to_regclass('public.stock_lot_genealogy_edges') IS NULL
     OR to_regclass('public.stock_inventory_snapshot_lines') IS NULL
     OR to_regclass('public.stock_inventory_count_events') IS NULL
     OR to_regclass('public.v_stock_availability_225') IS NULL THEN
    RAISE EXCEPTION '#225 ledger, history, inventory snapshot or availability objects are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_command_receipts_actor_key_uq'
      AND conrelid = 'public.stock_command_receipts'::regclass
  ) THEN
    RAISE EXCEPTION '#225 actor/idempotency uniqueness is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_protect_posted_stock_movement'
      AND tgrelid = 'public.stock_movements'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '#225 posted movement immutability trigger is missing';
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM public.v_stock_availability_225 WHERE qty_available < 0) AS negative_available_rows,
  (SELECT count(*) FROM public.v_stock_availability_225 WHERE qty_quarantine < 0) AS negative_quarantine_rows,
  (SELECT count(*) FROM public.v_stock_availability_225 WHERE qty_blocked < 0) AS negative_blocked_rows,
  (
    SELECT count(*)
    FROM public.v_stock_availability_225
    WHERE lot_status IN ('EN_ATTENTE', 'QUARANTAINE', 'BLOQUE')
      AND qty_available <> 0
  ) AS nonreleased_available_rows,
  (
    SELECT count(*)
    FROM public.stock_inventory_sessions
    WHERE status = 'CLOSED'
      AND snapshot_at IS NULL
  ) AS legacy_closed_without_snapshot,
  (
    SELECT count(*)
    FROM public.stock_inventory_sessions
    WHERE status = 'DRAFT'
      AND started_at IS NOT NULL
  ) AS draft_sessions_started_too_early,
  (
    SELECT count(*)
    FROM public.stock_inventory_sessions
    WHERE status IN ('OPEN', 'APPROVED', 'CLOSED')
      AND started_at IS NULL
  ) AS active_sessions_without_start;

SELECT
  trigger_name,
  event_manipulation,
  event_object_table
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN (
    'trg_protect_stock_command_receipt',
    'trg_protect_posted_stock_movement',
    'trg_protect_posted_stock_movement_line',
    'trg_protect_stock_movement_event',
    'trg_protect_stock_reservation_event',
    'trg_protect_stock_lot_event',
    'trg_protect_stock_lot_genealogy',
    'trg_protect_stock_inventory_session',
    'trg_protect_stock_inventory_line',
    'trg_protect_stock_inventory_session_movement',
    'trg_protect_stock_inventory_snapshot',
    'trg_protect_stock_inventory_count',
    'trg_prepare_stock_reservation',
    'trg_log_stock_reservation_event'
  )
ORDER BY event_object_table, trigger_name, event_manipulation;

SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    THEN has_table_privilege('cerp_app', 'public.stock_command_receipts', 'SELECT,INSERT')
    ELSE NULL
  END AS cerp_app_command_receipt_access,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    THEN has_table_privilege('cerp_app', 'public.v_stock_availability_225', 'SELECT')
    ELSE NULL
  END AS cerp_app_availability_access;
