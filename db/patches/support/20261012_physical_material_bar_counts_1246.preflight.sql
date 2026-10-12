\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regprocedure('public.check_material_bar_stock_1246()') IS NULL
    OR to_regclass('public.stock_inventory_count_events') IS NULL
    OR to_regclass('public.stock_inventory_snapshot_lines') IS NULL
    OR to_regclass('public.stock_inventory_session_movements') IS NULL THEN
    RAISE EXCEPTION 'Physical bar movements and canonical stock inventory are required before count support';
  END IF;
END $$;
