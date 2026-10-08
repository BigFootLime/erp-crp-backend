DO $$ BEGIN
  IF to_regclass('public.stock_valuation_manufacturing_sources') IS NULL
    OR to_regclass('public.margin_recalculations') IS NULL
    OR to_regclass('public.production_quantity_declarations') IS NULL
    OR to_regclass('public.stock_valuation_projector_control') IS NULL THEN
    RAISE EXCEPTION 'Manufacturing source, margin, production and Stock prerequisites missing';
  END IF;
  IF to_regclass('public.stock_valuation_manufacturing_bases') IS NOT NULL THEN
    RAISE EXCEPTION 'Manufacturing bases already exist; use migration status and verification';
  END IF;
END $$;
