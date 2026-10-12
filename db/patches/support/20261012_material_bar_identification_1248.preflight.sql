DO $$ BEGIN
  IF to_regclass('public.stock_material_bars') IS NULL OR to_regclass('public.identification_labels') IS NULL
    OR to_regclass('public.identification_scan_events') IS NULL
    OR to_regprocedure('public.check_material_bar_quality_1246()') IS NULL THEN
    RAISE EXCEPTION 'Material bar and identification prerequisites must be installed first';
  END IF;
END $$;
