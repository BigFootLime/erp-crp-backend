\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(), current_user;
SELECT 'public.of_dossier_validations'::regclass, 'public.of_self_inspection_sheets'::regclass,
       'public.of_preparation_evaluations'::regclass, 'public.piece_version_programming_tasks'::regclass;
SELECT 'public.fn_guard_preparation_execution_712()'::regprocedure;
SELECT preparation_rules_version, count(*) AS of_count
FROM public.ordres_fabrication GROUP BY preparation_rules_version ORDER BY preparation_rules_version;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgfoid='public.fn_guard_preparation_execution_712()'::regprocedure AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'Preparation execution guard is absent or disabled';
  END IF;
END $$;
COMMIT;
