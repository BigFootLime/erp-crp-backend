DO $verify$
BEGIN
  IF to_regclass('public.planning_user_preferences') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 verify: planning_user_preferences is missing';
  END IF;
  IF to_regprocedure('public.fn_planning_color_map_is_valid(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 verify: color validation function is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.planning_user_preferences'::regclass
       AND tgname = 'planning_user_preferences_set_updated_at'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'SOL-21 verify: updated_at trigger is missing or disabled';
  END IF;
  IF public.fn_planning_color_map_is_valid('{"id:C01":"#AABBCC"}'::jsonb) IS NOT TRUE
     OR public.fn_planning_color_map_is_valid('{"id:C01":"red"}'::jsonb) IS NOT FALSE THEN
    RAISE EXCEPTION 'SOL-21 verify: color validation does not fail closed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.production_pointages'::regclass
       AND conname = 'production_pointages_source_chk'
       AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%OFFLINE_STATION%'
  ) THEN
    RAISE EXCEPTION 'SOL-21 verify: offline pointage provenance is not accepted';
  END IF;
END
$verify$;

DO $runtime_privilege_verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    IF NOT has_table_privilege('cerp_app', 'public.machines', 'SELECT') THEN
      RAISE EXCEPTION 'SOL-21 verify: cerp_app cannot read machines';
    END IF;
    SET LOCAL ROLE cerp_app;
    PERFORM count(*) FROM public.v_station_machine_occupancy;
    RESET ROLE;
  END IF;
END
$runtime_privilege_verify$;

SELECT count(*) AS preferences_count,
       max(updated_at) AS preferences_freshness_at
  FROM public.planning_user_preferences;
