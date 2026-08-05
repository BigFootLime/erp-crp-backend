\set ON_ERROR_STOP on
\echo '=== GPT56-FEAT-CERP-0004 guarded rollback (dev/test only) ==='

BEGIN;

DO $rollback$
DECLARE
  evidence_count bigint;
BEGIN
  IF current_database() !~* '(test|dev|local|sandbox)' THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 rollback refused outside an explicitly named dev/test/local/sandbox database';
  END IF;
  IF to_regclass('public.programmation_reschedule_operations') IS NULL
     OR to_regclass('public.programmation_reschedule_events') IS NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 rollback: expected owned artifacts are missing';
  END IF;

  SELECT
    (SELECT COUNT(*) FROM public.programmation_reschedule_operations)
    + (SELECT COUNT(*) FROM public.programmation_reschedule_events)
    + (SELECT COUNT(*) FROM public.programmation_calendars)
    + (SELECT COUNT(*) FROM public.programmation_calendar_closures)
    + (SELECT COUNT(*) FROM public.programmation_user_skills)
    + (SELECT COUNT(*) FROM public.programmation_required_skills)
    + (SELECT COUNT(*) FROM public.programmation_dependencies)
    + (SELECT COUNT(*) FROM public.programmations
       WHERE version <> 1 OR machine_id IS NOT NULL OR poste_id IS NOT NULL
          OR of_operation_id IS NOT NULL OR calendar_id IS NOT NULL
          OR required_machine_family_code IS NOT NULL)
  INTO evidence_count;

  IF evidence_count <> 0 THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 rollback refused: % governed/evidence rows exist', evidence_count;
  END IF;
END
$rollback$;

DROP TRIGGER programmation_reschedule_events_immutable ON public.programmation_reschedule_events;
DROP FUNCTION public.fn_programmation_reschedule_event_immutable();
DROP TRIGGER programmation_calendars_set_updated_at ON public.programmation_calendars;

DROP TABLE public.programmation_reschedule_events;
DROP TABLE public.programmation_reschedule_operations;
DROP TABLE public.programmation_dependencies;
DROP TABLE public.programmation_required_skills;
DROP TABLE public.programmation_user_skills;
DROP TABLE public.programmation_calendar_closures;

ALTER TABLE public.programmations
  DROP CONSTRAINT programmations_machine_family_ck,
  DROP CONSTRAINT programmations_version_ck,
  DROP COLUMN required_machine_family_code,
  DROP COLUMN calendar_id,
  DROP COLUMN of_operation_id,
  DROP COLUMN poste_id,
  DROP COLUMN machine_id,
  DROP COLUMN version;

DROP TABLE public.programmation_calendars;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260805_programmation_safe_reschedule_0004.sql';

COMMIT;
