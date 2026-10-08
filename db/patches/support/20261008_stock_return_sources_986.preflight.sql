BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.stock_valuation_entries') IS NULL
    OR to_regclass('public.production_material_remnants') IS NULL
    OR to_regclass('public.production_material_debit_sources') IS NULL
    OR to_regprocedure('public.fn_stock_valuation_boundary_guard_977()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
      WHERE singleton AND mode='PREPARED' AND NOT initialized AND last_sequence=0)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_entries)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_return_allocations) THEN
    RAISE EXCEPTION 'Stock return provenance requires the empty inactive CUMP projector and material source registries';
  END IF;
END $$;
ROLLBACK;
