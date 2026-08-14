\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback SOL-24 autorise uniquement sur cerp_test; restaurer la sauvegarde en production';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_budget_versions)
     OR EXISTS (SELECT 1 FROM public.project_affaire_links)
     OR EXISTS (SELECT 1 FROM public.hr_absence_records)
     OR EXISTS (SELECT 1 FROM public.hr_period_closures)
     OR EXISTS (SELECT 1 FROM public.hr_kilometer_rate_versions) THEN
    RAISE EXCEPTION 'Rollback refuse: donnees SOL-24 presentes';
  END IF;
  IF EXISTS (SELECT 1 FROM public.hr_kilometer_entries WHERE cost_amount IS NOT NULL OR rate_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback refuse: cout kilometrique fige present';
  END IF;
END $$;

BEGIN;
ALTER TABLE public.hr_kilometer_entries DROP CONSTRAINT IF EXISTS hr_kilometer_entries_cost_0462_ck;
ALTER TABLE public.hr_kilometer_entries
  DROP COLUMN IF EXISTS cost_currency,
  DROP COLUMN IF EXISTS cost_amount,
  DROP COLUMN IF EXISTS rate_version_id;
DROP TABLE IF EXISTS public.hr_kilometer_rate_versions;
DROP TABLE IF EXISTS public.hr_period_closures;
DROP TABLE IF EXISTS public.hr_absence_records;
DROP TABLE IF EXISTS public.project_affaire_links;
DROP TABLE IF EXISTS public.project_budget_versions;
COMMIT;
