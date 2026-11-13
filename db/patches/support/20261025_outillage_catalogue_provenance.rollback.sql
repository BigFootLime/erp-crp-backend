-- Rollback is deliberately blocked once provenance evidence exists.
DO $$
BEGIN
  IF to_regclass('public.gestion_outils_catalogue_provenance') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.gestion_outils_catalogue_provenance LIMIT 1) THEN
    RAISE EXCEPTION 'Rollback refused: catalogue provenance contains operational evidence';
  END IF;
END $$;

ALTER TABLE public.gestion_outils_stock DROP COLUMN IF EXISTS last_inventory_at;
DROP TABLE IF EXISTS public.gestion_outils_catalogue_provenance;
DROP INDEX IF EXISTS public.gestion_outils_outil_fabricant_reference_ci_unique;
