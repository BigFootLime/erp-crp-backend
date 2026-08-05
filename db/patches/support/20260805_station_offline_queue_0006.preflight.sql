\set ON_ERROR_STOP on

DO $$
DECLARE missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN missing := array_append(missing, 'cerp_schema_migrations'); END IF;
  IF to_regclass('public.production_devices') IS NULL THEN missing := array_append(missing, 'production_devices'); END IF;
  IF to_regclass('public.operator_device_sessions') IS NULL THEN missing := array_append(missing, 'operator_device_sessions'); END IF;
  IF to_regclass('public.production_execution_idempotency') IS NULL THEN missing := array_append(missing, 'production_execution_idempotency'); END IF;
  IF to_regclass('public.production_pointages') IS NULL THEN missing := array_append(missing, 'production_pointages'); END IF;
  IF to_regclass('public.production_quantity_declarations') IS NULL THEN missing := array_append(missing, 'production_quantity_declarations'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
  IF to_regclass('public.production_station_offline_events') IS NOT NULL
     OR to_regclass('public.production_station_offline_config') IS NOT NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 target objects already exist';
  END IF;
END;
$$;
