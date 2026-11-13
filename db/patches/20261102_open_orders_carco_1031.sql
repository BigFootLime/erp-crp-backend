-- An open customer order is the envelope of a contract, never a sale or a stock movement.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.client_open_orders (
  contract_id uuid PRIMARY KEY REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  opened_version integer NOT NULL CHECK (opened_version > 0),
  reference_at_open text NOT NULL,
  opened_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.carco_reviews ALTER COLUMN received_by DROP NOT NULL,
  ADD COLUMN received_portal_account_id uuid REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT carco_review_single_author CHECK (num_nonnulls(received_by, received_portal_account_id)=1);
CREATE TABLE public.carco_review_contracts (
  review_id uuid PRIMARY KEY REFERENCES public.carco_reviews(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  reference_at_binding text NOT NULL,
  bound_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.carco_review_schedule_decisions (
  review_id uuid NOT NULL REFERENCES public.carco_reviews(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK(row_number>0),
  kind text NOT NULL CHECK(kind IN ('FIRM','FORECAST')),
  schedule_key text NOT NULL CHECK(length(trim(schedule_key)) BETWEEN 1 AND 160),
  decided_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(review_id,row_number)
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT, INSERT ON public.client_open_orders TO cerp_app;
  GRANT SELECT, INSERT ON public.carco_review_contracts TO cerp_app;
  GRANT SELECT, INSERT ON public.carco_review_schedule_decisions TO cerp_app;
  GRANT USAGE ON SEQUENCE public.client_open_orders_number_seq TO cerp_app;
END IF; END $$;
COMMIT;
