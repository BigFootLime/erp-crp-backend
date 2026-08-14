\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.project_budget_versions') IS NULL THEN missing := array_append(missing, 'project_budget_versions'); END IF;
  IF to_regclass('public.project_affaire_links') IS NULL THEN missing := array_append(missing, 'project_affaire_links'); END IF;
  IF to_regclass('public.hr_absence_records') IS NULL THEN missing := array_append(missing, 'hr_absence_records'); END IF;
  IF to_regclass('public.hr_period_closures') IS NULL THEN missing := array_append(missing, 'hr_period_closures'); END IF;
  IF to_regclass('public.hr_kilometer_rate_versions') IS NULL THEN missing := array_append(missing, 'hr_kilometer_rate_versions'); END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Objets SOL-24 manquants: %', array_to_string(missing, ', ');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hr_kilometer_entries' AND column_name = 'rate_version_id'
  ) THEN
    RAISE EXCEPTION 'Colonne hr_kilometer_entries.rate_version_id absente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='project_budget_versions_current_0462_uq') THEN
    RAISE EXCEPTION 'Unicite budget projet courant absente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='hr_absence_records_active_0462_uq') THEN
    RAISE EXCEPTION 'Protection doublon absence active absente';
  END IF;
END $$;

SELECT current_database() AS database_name,
       (SELECT COUNT(*) FROM public.project_budget_versions) AS project_budget_versions,
       (SELECT COUNT(*) FROM public.project_affaire_links) AS project_affaire_links,
       (SELECT COUNT(*) FROM public.hr_absence_records) AS absence_records,
       (SELECT COUNT(*) FROM public.hr_period_closures WHERE status='CLOSED') AS active_period_closures,
       (SELECT COUNT(*) FROM public.hr_kilometer_rate_versions) AS kilometer_rate_versions,
       (SELECT COUNT(*) FROM public.hr_kilometer_entries WHERE cost_amount IS NOT NULL AND rate_version_id IS NULL) AS kilometer_costs_without_rate;

SELECT COUNT(*) AS orphan_project_affaire_links
FROM public.project_affaire_links l
LEFT JOIN public.project_projects p ON p.id=l.project_id
LEFT JOIN public.affaire a ON a.id=l.affaire_id
WHERE p.id IS NULL OR a.id IS NULL;

SELECT COUNT(*) AS overlapping_open_budget_versions
FROM (
  SELECT project_id FROM public.project_budget_versions WHERE effective_to IS NULL GROUP BY project_id HAVING COUNT(*) > 1
) d;
