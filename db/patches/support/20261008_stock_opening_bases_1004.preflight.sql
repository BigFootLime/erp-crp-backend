DO $$ BEGIN
  IF to_regclass('public.stock_valuation_opening_quantities') IS NULL
    OR to_regclass('public.stock_valuation_entries') IS NULL
    OR to_regclass('public.stock_documents') IS NULL THEN
    RAISE EXCEPTION 'Opening declaration dependencies are missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
    WHERE mode='PREPARED' AND NOT initialized AND last_sequence=0 AND reporting_currency='EUR') THEN
    RAISE EXCEPTION 'Keep the projector prepared and uninitialized for this migration';
  END IF;
END $$;
