DO $$ BEGIN
  IF to_regclass('public.stock_valuation_manufacturing_bases') IS NULL THEN
    RAISE EXCEPTION 'Manufacturing bases table missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.stock_valuation_manufacturing_bases'::regclass
    AND NOT tgisinternal AND tgenabled='O'
    AND tgname IN('stock_manufacturing_bases_immutable','stock_manufacturing_bases_truncate_guard'))<>2 THEN
    RAISE EXCEPTION 'Manufacturing bases immutable guards missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_bases
    WHERE source_sha256<>encode(digest(source_snapshot::text,'sha256'),'hex') OR source_reliability<>'DECLARED') THEN
    RAISE EXCEPTION 'Manufacturing bases evidence invalid';
  END IF;
END $$;
