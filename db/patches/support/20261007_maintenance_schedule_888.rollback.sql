-- Operator rehearsal only. Keep all published calendar history and roll forward.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.production_maintenance_schedules)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_schedule_revisions)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_schedule_occurrences)
 THEN RAISE EXCEPTION 'Published maintenance history exists: keep schema and roll forward'; END IF;
END $$;
ALTER TABLE public.production_maintenance_schedules DROP CONSTRAINT maintenance_schedule_current_revision_888;
DROP TABLE public.production_maintenance_schedule_occurrences,public.production_maintenance_schedule_revisions,public.production_maintenance_schedules;
DROP FUNCTION public.guard_maintenance_schedule_rewrite_888();
ROLLBACK;
