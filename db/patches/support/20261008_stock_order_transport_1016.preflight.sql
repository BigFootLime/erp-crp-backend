BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.stock_valuation_acquisition_sources') IS NULL
    OR to_regprocedure('public.fn_stock_acquisition_capture_980()') IS NULL
    OR to_regclass('public.stock_valuation_acquisition_allocations') IS NULL
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname='stock_acquisition_capture_980' AND tgrelid='public.stock_valuation_movement_journal'::regclass
      AND tgfoid='public.fn_stock_acquisition_capture_980()'::regprocedure)<>1
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE singleton AND mode='PREPARED') THEN
    RAISE EXCEPTION 'Transport capture requires existing guarded acquisition capture and PREPARED valuation';
  END IF;
END $$;
ROLLBACK;
