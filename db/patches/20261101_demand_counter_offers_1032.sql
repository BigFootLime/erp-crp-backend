BEGIN;
ALTER TABLE public.demand_pilot_revisions ADD COLUMN accepted_need_date date;
CREATE TABLE public.demand_counter_offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision_id uuid NOT NULL REFERENCES public.demand_pilot_revisions(id),
 due_date date NOT NULL, customer_message text NOT NULL, actor_id integer NOT NULL REFERENCES public.users(id),
 status text NOT NULL CHECK(status IN('OPEN','AGREED','SUPERSEDED','DECLINED','CHECKED')),created_at timestamptz NOT NULL DEFAULT now(),
 answered_at timestamptz,answered_by uuid REFERENCES public.client_portal_accounts(id)
);
CREATE UNIQUE INDEX demand_single_open_counter ON public.demand_counter_offers(revision_id) WHERE status='OPEN';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT,UPDATE ON public.demand_counter_offers TO cerp_app; END IF; END $$;
COMMIT;
