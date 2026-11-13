DO $$
BEGIN
  IF to_regclass('public.gestion_outils_catalogue_provenance') IS NULL THEN
    RAISE EXCEPTION 'gestion_outils_catalogue_provenance is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gestion_outils_stock' AND column_name = 'last_inventory_at'
  ) THEN
    RAISE EXCEPTION 'gestion_outils_stock.last_inventory_at is missing';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.gestion_outils_outil_fabricant_reference_ci_unique') IS NULL THEN
    RAISE EXCEPTION 'manufacturer/reference unique index is missing';
  END IF;
END $$;
