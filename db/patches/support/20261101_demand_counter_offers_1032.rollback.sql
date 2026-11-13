BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.demand_counter_offers) OR EXISTS(SELECT 1 FROM public.demand_pilot_revisions WHERE accepted_need_date IS NOT NULL) THEN RAISE EXCEPTION 'Retain customer decisions before rollback'; END IF; END $$;
DROP TABLE public.demand_counter_offers;
ALTER TABLE public.demand_pilot_revisions DROP COLUMN accepted_need_date;
COMMIT;
