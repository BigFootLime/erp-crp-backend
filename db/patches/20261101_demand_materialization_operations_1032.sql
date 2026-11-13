BEGIN;
SET LOCAL lock_timeout='5s';

-- A demand revision can affect two months when the customer moves an
-- échéance.  Persist each child operation so an interrupted worker retries
-- the exact same canonical forecast command with the same actor/key.
CREATE TABLE IF NOT EXISTS public.demand_pilot_materialization_operations (
  revision_id uuid NOT NULL REFERENCES public.demand_pilot_revisions(id) ON DELETE RESTRICT,
  contract_line_id uuid NOT NULL REFERENCES public.client_contract_lines(id) ON DELETE RESTRICT,
  month date NOT NULL CHECK(extract(day FROM month)=1),
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','REVIEW')),
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(revision_id,contract_line_id,month)
);
CREATE INDEX IF NOT EXISTS demand_pilot_materialization_operations_pending_idx
  ON public.demand_pilot_materialization_operations(status,created_at);

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.demand_pilot_materialization_operations TO cerp_app;
  REVOKE DELETE,TRUNCATE ON public.demand_pilot_materialization_operations FROM cerp_app;
 END IF;
END $$;
COMMIT;
