BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.demand_pilot_import_requests) THEN RAISE EXCEPTION 'Retain the import receipt history before rollback.'; END IF; END $$;
DROP INDEX public.demand_pilot_source_version_unique;
ALTER TABLE public.demand_pilot_imports DROP COLUMN outcome;
DROP TABLE public.demand_pilot_import_requests;
COMMIT;
