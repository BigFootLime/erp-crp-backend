BEGIN;

CREATE TABLE IF NOT EXISTS public.cerp_intercompany_outbox (
  id uuid PRIMARY KEY,
  source_company_id uuid NOT NULL,
  destination_company_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('cerp_prod','cerp_test')),
  kind text NOT NULL,
  aggregate_id text NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 160),
  revision integer NOT NULL CHECK(revision > 0),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  message jsonb NOT NULL CHECK(jsonb_typeof(message) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  CHECK(source_company_id <> destination_company_id),
  UNIQUE(source_company_id,destination_company_id,environment,kind,aggregate_id,revision)
);
CREATE INDEX IF NOT EXISTS cerp_intercompany_outbox_pending_idx
  ON public.cerp_intercompany_outbox(next_attempt_at,created_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS public.cerp_intercompany_inbox (
  id uuid PRIMARY KEY,
  source_company_id uuid NOT NULL,
  destination_company_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('cerp_prod','cerp_test')),
  kind text NOT NULL,
  aggregate_id text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CHECK(source_company_id <> destination_company_id),
  UNIQUE(source_company_id,destination_company_id,environment,kind,aggregate_id,revision)
);

CREATE TABLE IF NOT EXISTS public.cerp_intercompany_requests (
  id uuid PRIMARY KEY,
  buyer_company_id uuid NOT NULL,
  supplier_company_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('cerp_prod','cerp_test')),
  buyer_purchase_order_id text NOT NULL,
  buyer_sales_order_id text NOT NULL,
  relation_id uuid NOT NULL,
  buyer_legal_snapshot jsonb NOT NULL CHECK(jsonb_typeof(buyer_legal_snapshot)='object' AND buyer_legal_snapshot <> '{}'::jsonb),
  final_delivery_address_snapshot jsonb NOT NULL CHECK(jsonb_typeof(final_delivery_address_snapshot)='object' AND final_delivery_address_snapshot <> '{}'::jsonb),
  revision integer NOT NULL CHECK(revision > 0),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'PENDING_SUPPLIER_APPROVAL' CHECK(state IN (
    'PENDING_SUPPLIER_APPROVAL','ACCEPTED','REJECTED','CANCEL_REQUESTED',
    'CANCELLATION_REJECTED','CANCELLED','PARTIALLY_FULFILLED','FULFILLED')),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  supplier_sales_order_id bigint REFERENCES public.commande_client(id),
  decision_reason text,
  decided_by integer REFERENCES public.users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(buyer_company_id <> supplier_company_id),
  UNIQUE(buyer_company_id,supplier_company_id,environment,buyer_purchase_order_id),
  CHECK(state NOT IN ('ACCEPTED','PARTIALLY_FULFILLED','FULFILLED') OR supplier_sales_order_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cerp_intercompany_requests_supplier_idx
  ON public.cerp_intercompany_requests(supplier_company_id,environment,state,created_at DESC);

CREATE TABLE IF NOT EXISTS public.cerp_intercompany_order_line_links (
  request_id uuid NOT NULL REFERENCES public.cerp_intercompany_requests(id),
  buyer_sales_order_line_id text NOT NULL,
  buyer_purchase_order_line_id text NOT NULL,
  supplier_sales_order_line_id bigint NOT NULL REFERENCES public.commande_ligne(id),
  supplier_article_id uuid NOT NULL REFERENCES public.articles(id),
  quantity numeric(20,6) NOT NULL CHECK(quantity > 0),
  unit text NOT NULL,
  PRIMARY KEY(request_id,buyer_sales_order_line_id),
  UNIQUE(supplier_sales_order_line_id),
  UNIQUE(request_id,buyer_purchase_order_line_id)
);
CREATE TABLE IF NOT EXISTS public.cerp_intercompany_decision_receipts (
  request_id uuid NOT NULL REFERENCES public.cerp_intercompany_requests(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 200),
  command_sha256 text NOT NULL CHECK(command_sha256 ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response) = 'object'),
  actor_user_id integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,idempotency_key)
);

DO $grant$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT,UPDATE ON public.cerp_intercompany_outbox,public.cerp_intercompany_inbox,
      public.cerp_intercompany_requests,public.cerp_intercompany_order_line_links TO cerp_app;
    GRANT SELECT,INSERT ON public.cerp_intercompany_decision_receipts TO cerp_app;
  END IF;
END $grant$;
COMMIT;
