BEGIN;
CREATE TABLE IF NOT EXISTS public.demand_pilot_firm_bindings (
  revision_id uuid PRIMARY KEY REFERENCES public.demand_pilot_revisions(id) ON DELETE RESTRICT,
  promise_root_id uuid NOT NULL REFERENCES public.delivery_promise_roots(id) ON DELETE RESTRICT,
  bound_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(promise_root_id)
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT ON public.demand_pilot_firm_bindings TO cerp_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.demand_pilot_firm_bindings FROM cerp_app;
 END IF;
END $$;
COMMIT;
