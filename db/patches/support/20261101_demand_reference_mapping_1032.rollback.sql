BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.demand_pilot_article_mappings) THEN RAISE EXCEPTION 'Retain article mapping evidence before rollback'; END IF; END $$;
DROP TABLE public.demand_pilot_article_mappings;
COMMIT;
