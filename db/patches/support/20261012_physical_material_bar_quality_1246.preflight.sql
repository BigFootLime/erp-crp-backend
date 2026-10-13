DO $$ BEGIN
  IF to_regprocedure('public.check_material_bar_stock_1246()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_batches' AND column_name='qty_depreciated') THEN
    RAISE EXCEPTION 'Physical movement and canonical depreciation schema must precede bar quality';
  END IF;
END $$;
