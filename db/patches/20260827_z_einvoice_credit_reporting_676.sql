-- #676 - Electronic credit notes and foreign/payment e-reporting foundations; ordered after supplier invoices.
-- Additive and deliberately inactive in production until explicit feature flags are enabled.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.avoir') IS NULL
     OR to_regclass('public.facture') IS NULL
     OR to_regclass('public.einvoice_billing_frame_catalog') IS NULL
     OR to_regclass('public.einvoice_documents') IS NULL
     OR to_regclass('public.supplier_invoices') IS NULL THEN
    RAISE EXCEPTION 'EINVOICE-676 missing prerequisites';
  END IF;
END
$guard$;

ALTER TABLE public.avoir ADD COLUMN IF NOT EXISTS billing_frame_catalog_version text NULL;
ALTER TABLE public.avoir ADD COLUMN IF NOT EXISTS billing_frame_code text NULL;
ALTER TABLE public.avoir ADD COLUMN IF NOT EXISTS operation_category text NULL;
ALTER TABLE public.avoir ADD COLUMN IF NOT EXISTS transaction_scope text NULL;
ALTER TABLE public.avoir ADD COLUMN IF NOT EXISTS regulatory_snapshot jsonb NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'avoir_regulatory_fields_676_ck') THEN
    ALTER TABLE public.avoir ADD CONSTRAINT avoir_regulatory_fields_676_ck CHECK (
      (billing_frame_catalog_version IS NULL AND billing_frame_code IS NULL
       AND operation_category IS NULL AND transaction_scope IS NULL AND regulatory_snapshot IS NULL)
      OR
      (billing_frame_catalog_version IS NOT NULL AND billing_frame_code IS NOT NULL
       AND operation_category IN ('GOODS','SERVICES','MIXED')
       AND transaction_scope IN ('FR_PRIVATE_B2B','FR_PUBLIC','FOREIGN_B2B','B2C','OUT_OF_SCOPE')
       AND jsonb_typeof(regulatory_snapshot) = 'object')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'avoir_billing_frame_676_fk') THEN
    ALTER TABLE public.avoir ADD CONSTRAINT avoir_billing_frame_676_fk
      FOREIGN KEY (billing_frame_catalog_version, billing_frame_code)
      REFERENCES public.einvoice_billing_frame_catalog(catalog_version, code)
      ON DELETE RESTRICT;
  END IF;
END
$constraints$;

CREATE TABLE public.einvoice_reporting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_kind text NOT NULL CHECK (reporting_kind IN ('TRANSACTION','PAYMENT')),
  company_role text NOT NULL CHECK (company_role IN ('SELLER','BUYER')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SUBMITTING','SUBMITTED','PARTIAL','REJECTED','CORRECTED')),
  provider_code text NOT NULL REFERENCES public.einvoice_provider_connections(provider_code) ON DELETE RESTRICT,
  provider_reporting_id text NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  last_submitted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_reporting_period_dates_676_ck CHECK (period_end >= period_start),
  CONSTRAINT einvoice_reporting_period_676_uq UNIQUE (reporting_kind, company_role, period_start, period_end, provider_code)
);

CREATE TABLE public.einvoice_reporting_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NULL REFERENCES public.einvoice_reporting_periods(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('CUSTOMER_INVOICE','CUSTOMER_CREDIT_NOTE','SUPPLIER_INVOICE')),
  facture_id bigint NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  avoir_id bigint NULL REFERENCES public.avoir(id) ON DELETE RESTRICT,
  supplier_invoice_id uuid NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  company_role text NOT NULL CHECK (company_role IN ('SELLER','BUYER')),
  transaction_date date NOT NULL,
  partner_country_code char(2) NOT NULL CHECK (partner_country_code ~ '^[A-Z]{2}$' AND partner_country_code <> 'FR'),
  partner_identifier text NOT NULL CHECK (char_length(btrim(partner_identifier)) BETWEEN 1 AND 200),
  document_number text NOT NULL CHECK (char_length(btrim(document_number)) BETWEEN 1 AND 200),
  document_type text NOT NULL CHECK (document_type IN ('INVOICE','CREDIT_NOTE')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_without_vat numeric(18,2) NOT NULL,
  total_vat numeric(18,2) NOT NULL,
  total_with_vat numeric(18,2) NOT NULL,
  vat_breakdown jsonb NOT NULL CHECK (jsonb_typeof(vat_breakdown) = 'array'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','REJECTED','CORRECTED')),
  provider_item_id text NULL,
  correction_of_id uuid NULL REFERENCES public.einvoice_reporting_transactions(id) ON DELETE RESTRICT,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  next_attempt_at timestamptz NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_reporting_transaction_source_676_ck CHECK (
    (facture_id IS NOT NULL)::int + (avoir_id IS NOT NULL)::int + (supplier_invoice_id IS NOT NULL)::int = 1
  )
);
CREATE UNIQUE INDEX einvoice_reporting_facture_676_uq ON public.einvoice_reporting_transactions(facture_id)
  WHERE facture_id IS NOT NULL AND correction_of_id IS NULL;
CREATE UNIQUE INDEX einvoice_reporting_avoir_676_uq ON public.einvoice_reporting_transactions(avoir_id)
  WHERE avoir_id IS NOT NULL AND correction_of_id IS NULL;
CREATE UNIQUE INDEX einvoice_reporting_supplier_invoice_676_uq ON public.einvoice_reporting_transactions(supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL AND correction_of_id IS NULL;
CREATE INDEX einvoice_reporting_transaction_queue_676_idx
  ON public.einvoice_reporting_transactions(next_attempt_at, created_at) WHERE status IN ('PENDING','REJECTED');

CREATE TABLE public.einvoice_reporting_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NULL REFERENCES public.einvoice_reporting_periods(id) ON DELETE RESTRICT,
  paiement_id bigint NOT NULL REFERENCES public.paiement(id) ON DELETE RESTRICT,
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  payment_date date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocated_amount numeric(18,2) NOT NULL CHECK (allocated_amount > 0),
  vat_breakdown jsonb NOT NULL CHECK (jsonb_typeof(vat_breakdown) = 'array'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','REJECTED','CORRECTED')),
  provider_item_id text NULL,
  correction_of_id uuid NULL REFERENCES public.einvoice_reporting_payments(id) ON DELETE RESTRICT,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  next_attempt_at timestamptz NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX einvoice_reporting_payment_676_uq
  ON public.einvoice_reporting_payments(paiement_id, facture_id) WHERE correction_of_id IS NULL;
CREATE INDEX einvoice_reporting_payment_queue_676_idx
  ON public.einvoice_reporting_payments(next_attempt_at, created_at) WHERE status IN ('PENDING','REJECTED');

CREATE TABLE public.einvoice_reporting_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_kind text NOT NULL CHECK (reporting_kind IN ('TRANSACTION','PAYMENT','PERIOD')),
  transaction_id uuid NULL REFERENCES public.einvoice_reporting_transactions(id) ON DELETE RESTRICT,
  payment_id uuid NULL REFERENCES public.einvoice_reporting_payments(id) ON DELETE RESTRICT,
  period_id uuid NULL REFERENCES public.einvoice_reporting_periods(id) ON DELETE RESTRICT,
  provider_code text NOT NULL REFERENCES public.einvoice_provider_connections(provider_code) ON DELETE RESTRICT,
  provider_receipt_id text NULL,
  outcome text NOT NULL CHECK (outcome IN ('ACCEPTED','REJECTED','OBSERVED')),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_reporting_receipt_source_676_ck CHECK (
    (transaction_id IS NOT NULL)::int + (payment_id IS NOT NULL)::int + (period_id IS NOT NULL)::int = 1
  )
);
CREATE UNIQUE INDEX einvoice_reporting_receipt_evidence_676_uq
  ON public.einvoice_reporting_receipts(reporting_kind, provider_code, payload_sha256);

CREATE TABLE public.einvoice_reporting_command_receipts (
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  command_type text NOT NULL CHECK (command_type IN ('REPORT_TRANSACTION','REPORT_PAYMENT')),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);

CREATE FUNCTION public.fn_einvoice_reporting_evidence_append_only_676()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; add a correction or receipt row instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER einvoice_reporting_receipts_append_only_676
  BEFORE UPDATE OR DELETE ON public.einvoice_reporting_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_reporting_evidence_append_only_676();
CREATE TRIGGER einvoice_reporting_commands_append_only_676
  BEFORE UPDATE OR DELETE ON public.einvoice_reporting_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_reporting_evidence_append_only_676();

REVOKE ALL ON TABLE public.einvoice_reporting_periods FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.einvoice_reporting_transactions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.einvoice_reporting_payments FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.einvoice_reporting_receipts FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.einvoice_reporting_command_receipts FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT ON TABLE public.einvoice_reporting_periods TO cerp_app;
GRANT UPDATE (status, provider_reporting_id, row_version, last_submitted_at, updated_at)
  ON TABLE public.einvoice_reporting_periods TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.einvoice_reporting_transactions TO cerp_app;
GRANT UPDATE (period_id, status, provider_item_id, row_version, next_attempt_at, attempt_count, last_error_code, updated_at)
  ON TABLE public.einvoice_reporting_transactions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.einvoice_reporting_payments TO cerp_app;
GRANT UPDATE (period_id, status, provider_item_id, row_version, next_attempt_at, attempt_count, last_error_code, updated_at)
  ON TABLE public.einvoice_reporting_payments TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.einvoice_reporting_receipts TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.einvoice_reporting_command_receipts TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_einvoice_reporting_evidence_append_only_676() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_einvoice_reporting_evidence_append_only_676() TO cerp_app;

COMMENT ON TABLE public.einvoice_reporting_transactions IS
  '#676 foreign B2B reporting source snapshots. Corrections add rows and never overwrite evidence.';
COMMENT ON TABLE public.einvoice_reporting_payments IS
  '#676 payment reporting allocations, generated only for explicitly qualified cash-accounting services.';

COMMIT;
