DO $$ BEGIN
  IF to_regclass('public.planning_tasks') IS NULL OR to_regclass('public.planning_forecast_state') IS NULL
    OR to_regclass('public.planning_recalculation_jobs') IS NULL THEN
    RAISE EXCEPTION 'Canonical forecast prerequisites missing';
  END IF;
  IF NOT has_table_privilege('cerp_app','public.planning_tasks','UPDATE') THEN
    RAISE EXCEPTION 'Forecast worker grant missing';
  END IF;
END $$;
