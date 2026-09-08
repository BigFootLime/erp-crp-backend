\set ON_ERROR_STOP on
SELECT forecast_issues FROM public.planning_tasks LIMIT 0;
SELECT singleton,calculated_at,source_revision,issue_count,last_error FROM public.planning_forecast_state;
DO $$ BEGIN
  IF NOT has_table_privilege('cerp_app','public.planning_forecast_state','SELECT,UPDATE') THEN RAISE EXCEPTION 'Missing forecast privileges'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.lots'::regclass AND tgname='planning_invalidate')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.commande_fournisseur'::regclass AND tgname='planning_invalidate') THEN RAISE EXCEPTION 'Missing stock/promise invalidation'; END IF;
END $$;
