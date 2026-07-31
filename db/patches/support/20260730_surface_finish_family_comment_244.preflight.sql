-- #244 preflight -- lecture seule, a executer avant la migration.
\set ON_ERROR_STOP on

SELECT
  current_database() AS database_name,
  to_regclass('public.surface_finish_families') IS NOT NULL AS families_table_exists,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'surface_finish_families'
      AND column_name = 'commentaire_template'
  ) AS comment_column_already_exists;
