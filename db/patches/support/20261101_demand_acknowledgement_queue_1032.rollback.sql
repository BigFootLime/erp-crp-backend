BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.demand_acknowledgement_jobs) THEN RAISE EXCEPTION 'Retain acknowledgement evidence before rollback'; END IF; END $$;
DROP TRIGGER demand_ack_after_materialization ON public.demand_pilot_revisions;
DROP FUNCTION public.queue_demand_acknowledgement_1032();
DROP TABLE public.demand_acknowledgement_jobs;
ALTER TABLE public.industrial_policies DROP COLUMN auto_ar_contact_id;
COMMIT;
