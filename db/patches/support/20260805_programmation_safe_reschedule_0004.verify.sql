\set ON_ERROR_STOP on
\echo '=== GPT56-FEAT-CERP-0004 verify (read-only) ==='

DO $verify$
DECLARE
  missing_columns integer;
BEGIN
  IF to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.programmation_calendar_closures') IS NULL
     OR to_regclass('public.programmation_user_skills') IS NULL
     OR to_regclass('public.programmation_required_skills') IS NULL
     OR to_regclass('public.programmation_dependencies') IS NULL
     OR to_regclass('public.programmation_reschedule_operations') IS NULL
     OR to_regclass('public.programmation_reschedule_events') IS NULL
     OR to_regprocedure('public.fn_programmation_reschedule_event_immutable()') IS NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 verify: target table/function missing';
  END IF;

  SELECT COUNT(*) INTO missing_columns
  FROM unnest(ARRAY[
    'version', 'machine_id', 'poste_id', 'of_operation_id',
    'calendar_id', 'required_machine_family_code'
  ]) AS wanted(column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'programmations'
      AND c.column_name = wanted.column_name
  );
  IF missing_columns <> 0 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 verify: % programmation columns missing', missing_columns;
  END IF;

  IF EXISTS (SELECT 1 FROM public.programmations WHERE version <= 0) THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 verify: invalid optimistic version';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'programmation_reschedule_events_immutable'
      AND tgenabled = 'O' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 verify: immutable audit trigger missing or disabled';
  END IF;
END
$verify$;

SELECT COUNT(*) AS programmation_count,
       COUNT(*) FILTER (WHERE version = 1) AS untouched_version_count,
       COUNT(*) FILTER (
         WHERE machine_id IS NOT NULL OR poste_id IS NOT NULL OR of_operation_id IS NOT NULL
            OR calendar_id IS NOT NULL OR required_machine_family_code IS NOT NULL
       ) AS explicitly_constrained_count
FROM public.programmations;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.programmation_reschedule_operations'::regclass,
  'public.programmation_reschedule_events'::regclass,
  'public.programmation_dependencies'::regclass
)
ORDER BY conname;
