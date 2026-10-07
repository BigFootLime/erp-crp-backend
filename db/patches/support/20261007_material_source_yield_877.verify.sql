DO $$ BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.production_material_debit_sources'::regclass
      AND attname IN('yield_good','yield_scrap') AND atttypid='integer'::regtype AND NOT attisdropped)<>2 THEN
    RAISE EXCEPTION 'Observed yield columns missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_material_debit_sources'::regclass
    AND conname='material_source_yield_pair' AND convalidated) THEN RAISE EXCEPTION 'Yield pair constraint missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_material_debit_sources'::regclass
    AND tgname='production_material_source_yield_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O') THEN
    RAISE EXCEPTION 'Deferred yield guard missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_material_debit_sources'::regclass
    AND tgname='production_material_debit_sources_immutable' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Immutable source proof guard missing';
  END IF;
END $$;
