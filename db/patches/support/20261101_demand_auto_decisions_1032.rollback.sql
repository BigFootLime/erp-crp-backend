BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.demand_pilot_auto_checks) THEN RAISE EXCEPTION 'Retain the automated decision evidence before rollback'; END IF; END $$;
DROP TABLE public.demand_pilot_auto_checks;
COMMIT;
