DO $$
BEGIN
  IF to_regclass('public.gestion_outils_outil') IS NULL OR to_regclass('public.gestion_outils_stock') IS NULL THEN
    RAISE EXCEPTION 'Outillage base tables are required before catalogue provenance';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.gestion_outils_outil
    WHERE id_fabricant IS NOT NULL AND reference_fabricant IS NOT NULL AND btrim(reference_fabricant) <> ''
    GROUP BY id_fabricant, lower(btrim(reference_fabricant))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Legacy manufacturer/reference duplicates must be resolved before applying 20261025_outillage_catalogue_provenance';
  END IF;
END $$;
