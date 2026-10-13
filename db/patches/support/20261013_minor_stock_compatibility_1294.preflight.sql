DO $$ BEGIN
  IF to_regclass('public.v_technical_stock_compatibility_832') IS NULL
    OR to_regclass('public.piece_technique_versions') IS NULL THEN
    RAISE EXCEPTION 'Minor stock compatibility prerequisites missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='piece_technique_versions'
      AND column_name IN ('copied_from_version_id','change_level','impact_interchangeabilite','statut','indice','piece_technique_id')) <> 6 THEN
    RAISE EXCEPTION 'Technical revision lineage is incomplete';
  END IF;
END $$;
