BEGIN READ ONLY;
DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Unexpected database';
  END IF;
  IF NOT has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'SELECT')
     OR NOT has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'INSERT')
     OR NOT has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'DELETE') THEN
    RAISE EXCEPTION 'Missing live-reference correction privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.stock_lot_event_log'::regclass
      AND t.tgenabled IN ('O', 'A') AND NOT t.tgisinternal
      AND p.proname = 'fn_protect_stock_immutable_evidence'
  ) THEN
    RAISE EXCEPTION 'Lot evidence protection is missing';
  END IF;
END $$;
SET LOCAL ROLE cerp_app;
-- Planning only: do not add ANALYZE. No reference is deleted by this check.
EXPLAIN DELETE FROM public.stock_lot_trace_references WHERE false;
COMMIT;
