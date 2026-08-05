\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback GPT56-FEAT-CERP-0006 is restricted to disposable cerp_test';
  END IF;
  IF to_regclass('public.production_station_offline_events') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.production_station_offline_events) THEN
    RAISE EXCEPTION 'Rollback refused: offline receipt data exists';
  END IF;
END;
$$;

BEGIN;
DROP FUNCTION IF EXISTS public.fn_purge_production_station_offline_events(integer);
DROP TRIGGER IF EXISTS trg_guard_production_station_offline_event_0006 ON public.production_station_offline_events;
DROP FUNCTION IF EXISTS public.fn_guard_production_station_offline_event();
DROP TABLE IF EXISTS public.production_station_offline_events;
DROP TABLE IF EXISTS public.production_station_offline_config;
COMMIT;
