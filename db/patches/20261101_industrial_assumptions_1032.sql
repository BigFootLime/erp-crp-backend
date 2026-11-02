BEGIN;
ALTER TABLE public.industrial_contract_rules ADD COLUMN use_history boolean NOT NULL DEFAULT false;
ALTER TABLE public.industrial_policies ADD COLUMN transit_calendar_days smallint CHECK(transit_calendar_days BETWEEN 0 AND 180);
CREATE TABLE public.industrial_pic_targets(
 client_id varchar NOT NULL REFERENCES public.clients(client_id),month date NOT NULL CHECK(extract(day FROM month)=1),
 family text NOT NULL,unit text NOT NULL,revenue_target_eur numeric(18,2) CHECK(revenue_target_eur>=0),
 stock_target numeric(18,3) CHECK(stock_target>=0), updated_by integer NOT NULL REFERENCES public.users(id),
 PRIMARY KEY(client_id,month,family,unit)
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT,UPDATE ON public.industrial_pic_targets TO cerp_app; END IF; END $$;
COMMIT;
