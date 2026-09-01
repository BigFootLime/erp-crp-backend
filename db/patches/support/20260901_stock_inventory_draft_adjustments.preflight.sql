\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Inventory draft-adjustment preflight refused on database %', current_database();
  END IF;

  IF to_regclass('public.stock_inventory_session_movements') IS NULL
     OR to_regclass('public.stock_inventory_snapshot_lines') IS NULL
     OR to_regclass('public.stock_movements') IS NULL THEN
    RAISE EXCEPTION 'Inventory draft-adjustment preflight refused: required stock tables are missing';
  END IF;
END
$$;

COMMIT;
