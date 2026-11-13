BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.demand_pilot_import_requests(
 actor text NOT NULL,idempotency_key uuid NOT NULL,request_hash char(64) NOT NULL,import_id uuid NOT NULL REFERENCES public.demand_pilot_imports(id),
 PRIMARY KEY(actor,idempotency_key)
);
ALTER TABLE public.demand_pilot_imports ADD COLUMN outcome jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX demand_pilot_source_version_unique ON public.demand_pilot_imports(client_id,external_site,source_version);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT ON public.demand_pilot_import_requests TO cerp_app; GRANT SELECT,INSERT,DELETE ON public.client_portal_demand_sites TO cerp_app; END IF; END $$;
COMMIT;
