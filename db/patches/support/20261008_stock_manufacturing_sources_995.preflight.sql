BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.of_receipts') IS NULL OR to_regclass('public.margin_recalculations') IS NULL
    OR to_regclass('public.production_quantity_declarations') IS NULL
    OR to_regprocedure('public.fn_stock_valuation_boundary_guard_977()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
      WHERE singleton AND mode='PREPARED' AND NOT initialized AND last_sequence=0)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_entries) THEN
    RAISE EXCEPTION 'Manufacturing provenance requires canonical receipt sources and the empty inactive projector';
  END IF;
END $$;
ROLLBACK;
