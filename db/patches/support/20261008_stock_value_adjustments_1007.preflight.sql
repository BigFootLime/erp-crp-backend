DO $$ BEGIN
  IF to_regclass('public.stock_valuation_value_adjustments') IS NOT NULL THEN
    RAISE EXCEPTION 'Value adjustment migration already present; verify migration inventory';
  END IF;
  IF to_regclass('public.stock_valuation_balances') IS NULL
    OR to_regclass('public.stock_valuation_movement_journal') IS NULL
    OR to_regclass('public.stock_valuation_capture_boundary') IS NULL
    OR to_regclass('public.stock_documents') IS NULL
    OR to_regclass('public.article_documents') IS NULL
    OR to_regprocedure('public.fn_stock_opening_scope_1004(text)') IS NULL
    OR to_regprocedure('public.fn_stock_valuation_entry_guard_983()') IS NULL
    OR to_regprocedure('public.fn_stock_valuation_balance_guard_983()') IS NULL THEN
    RAISE EXCEPTION 'Stock value adjustment dependencies are missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
    WHERE singleton AND mode='PREPARED' AND NOT initialized AND last_sequence=0 AND reporting_currency='EUR') THEN
    RAISE EXCEPTION 'This delivery must retain the prepared uninitialized Stock projector';
  END IF;
END $$;
