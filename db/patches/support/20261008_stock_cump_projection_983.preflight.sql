BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.stock_valuation_movement_journal') IS NULL
    OR to_regclass('public.stock_valuation_opening_quantities') IS NULL
    OR to_regclass('public.stock_valuation_acquisition_sources') IS NULL
    OR to_regprocedure('public.fn_stock_acquisition_guard_980()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_capture_boundary WHERE mode='CAPTURE_ONLY') THEN
    RAISE EXCEPTION 'Stock CUMP projection prerequisites missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j
    WHERE j.source_sha256<>encode(digest(j.source_snapshot::text,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'Stock journal integrity must be restored before projection preparation';
  END IF;
END $$;
ROLLBACK;
