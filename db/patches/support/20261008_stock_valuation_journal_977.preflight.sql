BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.stock_movements') IS NULL OR to_regclass('public.stock_movement_lines') IS NULL
    OR to_regclass('public.stock_levels') IS NULL OR to_regclass('public.stock_batches') IS NULL
    OR to_regclass('public.lots') IS NULL OR to_regclass('public.units') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app')
    OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN
    RAISE EXCEPTION 'Stock valuation source journal prerequisites missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stock_movement_lines' AND column_name='unit_cost'
      AND data_type='numeric' AND numeric_scale<=12)
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stock_movements' AND column_name='reversal_of_id') THEN
    RAISE EXCEPTION 'Stock valuation source precision or reversal contract missing';
  END IF;
END $$;
ROLLBACK;
