-- ROLLBACK for 20260709_hr_module_ownership.sql   (SUPERUSER ONLY)
--
-- Rend les 14 tables CRUD du module à postgres (état « appliqué en direct sans normalisation »).
-- hr_time_events n'est pas concerné (géré par son propre append-only). Non destructif, idempotent.
--
--   sudo -u postgres psql -d <db> -f db/privileged/20260709_hr_module_ownership.rollback.sql

BEGIN;

DO $rb$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_employees','hr_time_rule_sets','hr_employment_contracts','hr_work_schedules',
    'hr_time_clock_devices','hr_badge_credentials','hr_work_sessions','hr_timesheet_days',
    'hr_timesheet_weeks','hr_time_adjustments','hr_time_anomalies','hr_vehicles',
    'hr_kilometer_entries','hr_payroll_export_batches'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', t);
    END IF;
  END LOOP;
END
$rb$;

COMMIT;
