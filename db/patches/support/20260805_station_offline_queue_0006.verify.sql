\set ON_ERROR_STOP on

BEGIN;
DO $$
BEGIN
  IF to_regclass('public.production_station_offline_events') IS NULL
     OR to_regclass('public.production_station_offline_config') IS NULL
     OR to_regprocedure('public.fn_purge_production_station_offline_events(integer)') IS NULL
     OR to_regprocedure('public.fn_guard_production_station_offline_event()') IS NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 object missing';
  END IF;
  IF (SELECT count(*) FROM public.production_station_offline_config WHERE singleton AND enabled) <> 1 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 kill-switch configuration invalid';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.production_station_offline_events'::regclass
      AND conname IN ('production_station_offline_events_pkey','production_station_offline_events_idem_uq',
                      'production_station_offline_events_type_ck','production_station_offline_events_status_ck',
                      'production_station_offline_events_outcome_ck','production_station_offline_events_lease_ck',
                      'production_station_offline_events_execution_session_ck',
                      'production_station_offline_events_authenticated_device_fk',
                      'production_station_offline_events_authenticated_user_fk',
                      'production_station_offline_events_authenticated_session_fk',
                      'production_station_offline_events_authenticated_machine_fk')) <> 11 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 constraint set incomplete';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'production_station_offline_events'
         AND column_name IN ('authenticated_device_id','authenticated_operator_user_id',
                             'authenticated_station_session_id','authenticated_machine_id',
                             'processing_token','lease_expires_at','execution_session_id')) <> 7 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 fencing/authentication columns incomplete';
  END IF;
  IF has_table_privilege('cerp_app', 'public.production_station_offline_config', 'UPDATE') THEN
    RAISE EXCEPTION 'cerp_app must not control the database kill switch';
  END IF;
END;
$$;
ROLLBACK;
