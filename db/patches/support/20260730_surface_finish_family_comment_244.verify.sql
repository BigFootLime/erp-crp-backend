-- #244 verify -- lecture seule, a executer apres la migration.
\set ON_ERROR_STOP on

SELECT
  current_database() AS database_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'surface_finish_families'
      AND column_name = 'commentaire_template'
  ) AS comment_column_exists,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'surface_finish_families_commentaire_template_length_check'
      AND conrelid = 'public.surface_finish_families'::regclass
  ) AS length_check_exists,
  COUNT(*) FILTER (WHERE commentaire_template IS NOT NULL) AS configured_families
FROM public.surface_finish_families;
