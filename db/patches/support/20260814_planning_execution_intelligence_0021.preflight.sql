-- Read-only preflight. Run after a verified encrypted backup and before SOL-21.
DO $preflight$
DECLARE
  invalid_timezone_count bigint;
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-21 preflight: PostgreSQL 14 or newer is required';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.planning_events') IS NULL
     OR to_regclass('public.of_operations') IS NULL
     OR to_regclass('public.ordres_fabrication') IS NULL
     OR to_regclass('public.machines') IS NULL
     OR to_regclass('public.postes') IS NULL
     OR to_regclass('public.production_pointages') IS NULL
     OR to_regclass('public.production_activity_categories') IS NULL
     OR to_regclass('public.production_quantity_declarations') IS NULL
     OR to_regclass('public.production_machine_unavailability') IS NULL
     OR to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.programmation_calendar_closures') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 preflight: a source relation is missing';
  END IF;
  IF to_regprocedure('public.tg_set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 preflight: updated_at trigger function is missing';
  END IF;
  SELECT count(*) INTO invalid_timezone_count
    FROM public.programmation_calendars calendar
   WHERE NOT EXISTS (SELECT 1 FROM pg_timezone_names zone WHERE zone.name = calendar.timezone);
  IF invalid_timezone_count > 0 THEN
    RAISE EXCEPTION 'SOL-21 preflight: % production calendar(s) use an unknown timezone', invalid_timezone_count;
  END IF;
END
$preflight$;

DO $station_view_preflight$
BEGIN
  IF to_regclass('public.v_station_machine_occupancy') IS NULL THEN
    RAISE EXCEPTION 'SOL-21 preflight: station occupancy view is missing';
  END IF;
END
$station_view_preflight$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_database_size(current_database()) AS database_size_bytes,
       (SELECT count(*) FROM public.planning_events) AS planning_events,
       (SELECT count(*) FROM public.production_pointages) AS production_pointages,
       (SELECT count(*) FROM public.programmation_calendars WHERE active) AS active_calendars,
       now() AS checked_at;
