-- SOL-27 / issue #480 — Versioned, auditable and idempotent accounting export boundary.
BEGIN;

-- The #469 function is shared by facture and avoir triggers. Direct field access to
-- OLD.document_status made PostgreSQL fail while compiling the avoir trigger because
-- that legacy table has no such column. JSON access keeps the invoice exception while
-- preserving the common trigger contract for credit notes.
CREATE OR REPLACE FUNCTION public.fn_protect_facturation_immutable_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut IN (
      'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
      'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
    ) THEN
      RAISE EXCEPTION 'issued or cancelled finance evidence cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'facture'
     AND COALESCE(old_row->>'document_status','') = 'ISSUED'
     AND COALESCE(new_row->>'document_status','') = 'ISSUED'
     AND OLD.statut IN (
       'ISSUED', 'PARTIALLY_PAID', 'PAID',
       'emise', 'envoyee', 'partielle', 'payee', 'emis'
     )
     AND (
       (new_row->>'settlement_status' = 'UNPAID' AND new_row->>'statut' = 'ISSUED')
       OR (new_row->>'settlement_status' <> 'UNPAID' AND new_row->>'statut' = new_row->>'settlement_status')
     )
     AND (new_row->>'row_version')::integer = (old_row->>'row_version')::integer + 1
     AND current_setting('cerp.finance_settlement_correlation_id', true) IS NOT NULL
     AND current_setting('cerp.finance_settlement_correlation_id', true) = NEW.correlation_id::text
     AND (new_row - 'statut' - 'document_status' - 'settlement_status' - 'row_version' - 'correlation_id' - 'updated_at')
         IS NOT DISTINCT FROM
         (old_row - 'statut' - 'document_status' - 'settlement_status' - 'row_version' - 'correlation_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF OLD.statut IN (
    'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
  ) THEN
    RAISE EXCEPTION 'issued or cancelled finance evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.statut = 'DRAFT' AND NEW.statut = 'CANCELLED' THEN
    RAISE EXCEPTION 'draft finance evidence must not be cancelled as legal evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.accounting_export_mapping_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_code text NOT NULL UNIQUE,
  adapter_code text NOT NULL CHECK (adapter_code IN ('GENERIC_DELIMITED_V1')),
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  effective_from date NOT NULL,
  effective_to date NULL,
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  activated_at timestamptz NULL,
  activated_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  retired_at timestamptz NULL,
  retired_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT accounting_mapping_dates_sol27_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT accounting_mapping_activation_sol27_ck CHECK (
    (status='ACTIVE' AND activated_at IS NOT NULL AND activated_by IS NOT NULL)
    OR status<>'ACTIVE'
  )
);
CREATE INDEX IF NOT EXISTS accounting_mapping_effective_sol27_idx
  ON public.accounting_export_mapping_versions(status,effective_from,effective_to);

CREATE TABLE IF NOT EXISTS public.accounting_export_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number text NOT NULL UNIQUE,
  mapping_version_id uuid NOT NULL REFERENCES public.accounting_export_mapping_versions(id) ON DELETE RESTRICT,
  period_from date NOT NULL,
  period_to date NOT NULL,
  source_types text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('PREVIEWED','VALIDATED','GENERATED','CANCELLED')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  source_count integer NOT NULL CHECK (source_count >= 0),
  line_count integer NOT NULL CHECK (line_count >= 0),
  currency_totals jsonb NOT NULL CHECK (jsonb_typeof(currency_totals)='array'),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings)='array'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  lines_sha256 text NOT NULL CHECK (lines_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_filename text NULL,
  artifact_sha256 text NULL CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_size bigint NULL CHECK (artifact_size IS NULL OR artifact_size > 0),
  artifact_content bytea NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  validated_at timestamptz NULL,
  validated_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  generated_at timestamptz NULL,
  generated_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz NULL,
  cancelled_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cancellation_reason text NULL,
  reexport_of_batch_id uuid NULL REFERENCES public.accounting_export_batches(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  CONSTRAINT accounting_batch_period_sol27_ck CHECK (period_to >= period_from),
  CONSTRAINT accounting_batch_sources_sol27_ck CHECK (
    cardinality(source_types) BETWEEN 1 AND 3
    AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT']::text[]
  ),
  CONSTRAINT accounting_batch_artifact_sol27_ck CHECK (
    status <> 'GENERATED' OR (
      artifact_filename IS NOT NULL AND artifact_sha256 IS NOT NULL
      AND artifact_size IS NOT NULL AND artifact_content IS NOT NULL
      AND generated_at IS NOT NULL AND generated_by IS NOT NULL
    )
  ),
  CONSTRAINT accounting_batch_cancel_sol27_ck CHECK (
    status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND length(btrim(cancellation_reason)) >= 8)
  )
);
CREATE INDEX IF NOT EXISTS accounting_batches_status_sol27_idx ON public.accounting_export_batches(status,created_at DESC);
CREATE INDEX IF NOT EXISTS accounting_batches_period_sol27_idx ON public.accounting_export_batches(period_from,period_to);

CREATE TABLE IF NOT EXISTS public.accounting_export_batch_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.accounting_export_batches(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT')),
  source_id text NOT NULL,
  source_number text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_batch_source_sol27_uq UNIQUE(batch_id,source_type,source_id)
);

CREATE TABLE IF NOT EXISTS public.accounting_export_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.accounting_export_batches(id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no > 0),
  source_type text NOT NULL CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT')),
  source_id text NOT NULL,
  source_number text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  entry_date date NOT NULL,
  journal_code text NOT NULL CHECK (journal_code ~ '^[A-Za-z0-9]{1,12}$'),
  account_number text NOT NULL CHECK (account_number ~ '^[A-Za-z0-9]{3,20}$'),
  third_party_account text NULL CHECK (third_party_account IS NULL OR third_party_account ~ '^[A-Za-z0-9]{3,20}$'),
  label text NOT NULL,
  piece_reference text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  tax_rate numeric(8,4) NULL CHECK (tax_rate IS NULL OR tax_rate BETWEEN 0 AND 100),
  axes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(axes)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_entry_side_sol27_ck CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  CONSTRAINT accounting_entry_line_sol27_uq UNIQUE(batch_id,line_no)
);
CREATE INDEX IF NOT EXISTS accounting_entries_source_sol27_idx ON public.accounting_export_entries(source_type,source_id);

CREATE TABLE IF NOT EXISTS public.accounting_export_source_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.accounting_export_batches(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT')),
  source_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claimed_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  released_at timestamptz NULL,
  released_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  release_reason text NULL,
  CONSTRAINT accounting_claim_release_sol27_ck CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND length(btrim(release_reason)) >= 8)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_source_active_claim_sol27_uq
  ON public.accounting_export_source_claims(source_type,source_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS accounting_claim_batch_sol27_idx ON public.accounting_export_source_claims(batch_id,claimed_at);

CREATE TABLE IF NOT EXISTS public.accounting_export_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  command_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_command_receipt_sol27_uq UNIQUE(actor_user_id,idempotency_key)
);

CREATE OR REPLACE FUNCTION public.fn_protect_accounting_export_sol27()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'accounting_export_batches' THEN
    IF OLD.status IN ('GENERATED','CANCELLED') THEN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.mapping_version_id IS DISTINCT FROM OLD.mapping_version_id
         OR NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to
         OR NEW.source_types IS DISTINCT FROM OLD.source_types OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
         OR NEW.lines_sha256 IS DISTINCT FROM OLD.lines_sha256 OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
         OR NEW.artifact_content IS DISTINCT FROM OLD.artifact_content THEN
        RAISE EXCEPTION 'SOL-27 immutable accounting batch evidence cannot be modified';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO parent_status FROM public.accounting_export_batches WHERE id=COALESCE(NEW.batch_id,OLD.batch_id);
  IF parent_status IN ('VALIDATED','GENERATED','CANCELLED') THEN
    RAISE EXCEPTION 'SOL-27 immutable accounting export evidence cannot be modified';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

DROP TRIGGER IF EXISTS trg_protect_accounting_batch_sol27 ON public.accounting_export_batches;
CREATE TRIGGER trg_protect_accounting_batch_sol27 BEFORE UPDATE ON public.accounting_export_batches
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_accounting_export_sol27();
DROP TRIGGER IF EXISTS trg_protect_accounting_sources_sol27 ON public.accounting_export_batch_sources;
CREATE TRIGGER trg_protect_accounting_sources_sol27 BEFORE UPDATE OR DELETE ON public.accounting_export_batch_sources
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_accounting_export_sol27();
DROP TRIGGER IF EXISTS trg_protect_accounting_entries_sol27 ON public.accounting_export_entries;
CREATE TRIGGER trg_protect_accounting_entries_sol27 BEFORE UPDATE OR DELETE ON public.accounting_export_entries
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_accounting_export_sol27();

COMMENT ON TABLE public.accounting_export_mapping_versions IS 'SOL-27 versioned accounting mappings; no vendor contract is implied by GENERIC_DELIMITED_V1.';
COMMENT ON TABLE public.accounting_export_batches IS 'SOL-27 auditable preview/validation/generation/cancellation lifecycle.';
COMMENT ON COLUMN public.accounting_export_batches.artifact_content IS 'Generated UTF-8 delimited artifact retained for integrity-controlled download; never written to application logs.';

COMMIT;
