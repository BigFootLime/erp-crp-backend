BEGIN;
CREATE TABLE public.demand_pilot_article_mappings(
 client_id varchar NOT NULL REFERENCES public.clients(client_id), external_code text NOT NULL, external_unit text NOT NULL,
 article_id uuid NOT NULL REFERENCES public.articles(id), units_per_external numeric(18,6) NOT NULL CHECK(units_per_external>0),
 actor_id integer NOT NULL REFERENCES public.users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(client_id,external_code,external_unit)
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT,UPDATE ON public.demand_pilot_article_mappings TO cerp_app; END IF; END $$;
COMMIT;
