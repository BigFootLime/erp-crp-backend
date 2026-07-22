\set ON_ERROR_STOP on

SELECT
  to_regclass('public.production_machine_idempotence') IS NOT NULL AS has_idempotence,
  to_regclass('public.production_machine_maintenance_plans') IS NOT NULL AS has_maintenance_plans,
  to_regclass('public.production_machine_unavailability') IS NOT NULL AS has_unavailability,
  to_regclass('public.production_machine_maintenance_events') IS NOT NULL AS has_maintenance_events;

SELECT
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'hourly_rate';

SELECT prosrc ~ 'MCH' AS whitelist_has_mch
FROM pg_proc
WHERE proname = 'fn_next_issued_code_value' AND pronamespace = 'public'::regnamespace;

DO $$
DECLARE v bigint;
BEGIN
  BEGIN
    v := public.fn_next_issued_code_value('ROGUE');
    RAISE EXCEPTION 'verify FAILED: rogue code scope accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'ok: rogue code scope rejected';
  END;
END $$;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE 'production_machine_%'
ORDER BY indexname;
