-- Restore the live-reference correction privilege already specified by
-- 20260831_stock_article_inventory_revision_ux.sql. Evidence tables are untouched.
BEGIN;
DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Unexpected database for inventory privilege repair';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    OR to_regclass('public.stock_lot_trace_references') IS NULL
    OR to_regclass('public.stock_lot_event_log') IS NULL THEN
    RAISE EXCEPTION 'Inventory traceability prerequisites are missing';
  END IF;
END $$;
GRANT DELETE ON TABLE public.stock_lot_trace_references TO cerp_app;
COMMIT;
