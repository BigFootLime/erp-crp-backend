-- Operator-only. Never run automatically or when any maintenance history exists.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.production_maintenance_authorizations)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_receipts)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_holds)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_counter_readings)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_commands)
 THEN RAISE EXCEPTION 'Maintenance history exists: keep schema and roll forward'; END IF;
END $$;
DROP TRIGGER production_maintenance_event_guard_867 ON public.production_machine_maintenance_events;
DROP TRIGGER production_maintenance_evidence_guard_867 ON public.production_machine_documents;
DROP TABLE public.production_maintenance_holds,public.production_maintenance_receipts,public.production_maintenance_authorizations,public.production_maintenance_counter_readings,public.production_maintenance_commands;
DROP FUNCTION public.guard_maintenance_hold_rewrite_867(),public.guard_maintenance_evidence_rewrite_867(),public.guard_maintenance_event_rewrite_867();
ALTER TABLE public.production_machine_maintenance_plans DROP COLUMN counter_value,DROP COLUMN next_due_counter;
ROLLBACK;
