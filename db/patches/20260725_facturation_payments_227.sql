-- Issue #227 - Invoicing, credit notes, due dates and payments.
-- Additive/idempotent foundation only. It never issues an invoice, enables a
-- Finance rule or changes legacy business data. Apply only after the matching
-- read-only preflight and an approved backup.

BEGIN;

DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'facture', 'facture_ligne', 'avoir', 'avoir_ligne', 'paiement',
    'clients', 'users', 'documents_clients', 'bon_livraison_ligne', 'commande_ligne'
  ]
  LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION '#227 prerequisite missing: public.%', required_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'facture'
      AND column_name = 'id' AND data_type = 'bigint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'facture_ligne'
      AND column_name = 'id' AND data_type = 'bigint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'avoir'
      AND column_name = 'id' AND data_type = 'bigint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'paiement'
      AND column_name = 'id' AND data_type = 'bigint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bon_livraison_ligne'
      AND column_name = 'id' AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION '#227 requires bigint facture/line/avoir/paiement ids and UUID bon_livraison_ligne ids';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.finance_billing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version text NOT NULL UNIQUE,
  legal_entity_code text NOT NULL,
  eligible_delivery_statuses text[] NOT NULL DEFAULT ARRAY['SHIPPED','DELIVERED']::text[],
  require_distinct_issuer boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT finance_billing_policies_dates_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT finance_billing_policies_statuses_ck CHECK (cardinality(eligible_delivery_statuses) > 0)
);

CREATE TABLE IF NOT EXISTS public.finance_legal_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL CHECK (document_type IN ('FACTURE','AVOIR')),
  entity_code text NOT NULL,
  period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}$'),
  prefix text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  padding integer NOT NULL DEFAULT 6 CHECK (padding BETWEEN 1 AND 12),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_legal_sequences_scope_uq UNIQUE (document_type, entity_code, period_key)
);

ALTER TABLE public.facture
  ADD COLUMN IF NOT EXISTS uuid uuid NULL,
  ADD COLUMN IF NOT EXISTS draft_reference text NULL,
  ADD COLUMN IF NOT EXISTS legal_number text NULL,
  ADD COLUMN IF NOT EXISTS legal_period text NULL,
  ADD COLUMN IF NOT EXISTS legal_sequence_value bigint NULL,
  ADD COLUMN IF NOT EXISTS total_tax numeric(18,2) NULL,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS customer_text text NULL,
  ADD COLUMN IF NOT EXISTS preview_hash text NULL,
  ADD COLUMN IF NOT EXISTS policy_version text NULL,
  ADD COLUMN IF NOT EXISTS legal_entity_code text NULL,
  ADD COLUMN IF NOT EXISTS client_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS issuer_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS immutable_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS document_checksum_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS created_by integer NULL,
  ADD COLUMN IF NOT EXISTS validation_requested_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS validation_requested_by integer NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approved_by integer NULL,
  ADD COLUMN IF NOT EXISTS validation_reason text NULL,
  ADD COLUMN IF NOT EXISTS issued_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS issued_by integer NULL,
  ADD COLUMN IF NOT EXISTS issue_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS issue_snapshot_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS due_date_locked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL;

ALTER TABLE public.avoir
  ADD COLUMN IF NOT EXISTS uuid uuid NULL,
  ADD COLUMN IF NOT EXISTS draft_reference text NULL,
  ADD COLUMN IF NOT EXISTS legal_number text NULL,
  ADD COLUMN IF NOT EXISTS legal_period text NULL,
  ADD COLUMN IF NOT EXISTS legal_sequence_value bigint NULL,
  ADD COLUMN IF NOT EXISTS total_tax numeric(18,2) NULL,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS reason_code text NULL,
  ADD COLUMN IF NOT EXISTS preview_hash text NULL,
  ADD COLUMN IF NOT EXISTS client_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS issuer_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS immutable_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS document_checksum_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS legal_entity_code text NULL,
  ADD COLUMN IF NOT EXISTS created_by integer NULL,
  ADD COLUMN IF NOT EXISTS validation_requested_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS validation_requested_by integer NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approved_by integer NULL,
  ADD COLUMN IF NOT EXISTS validation_reason text NULL,
  ADD COLUMN IF NOT EXISTS issued_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS issued_by integer NULL,
  ADD COLUMN IF NOT EXISTS issue_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS issue_snapshot_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL;

ALTER TABLE public.facture_ligne
  ADD COLUMN IF NOT EXISTS tax_amount numeric(18,2) NULL,
  ADD COLUMN IF NOT EXISTS snapshot_json jsonb NULL;

ALTER TABLE public.avoir_ligne
  ADD COLUMN IF NOT EXISTS tax_amount numeric(18,2) NULL,
  ADD COLUMN IF NOT EXISTS snapshot_json jsonb NULL;

ALTER TABLE public.paiement
  ADD COLUMN IF NOT EXISTS uuid uuid NULL,
  ADD COLUMN IF NOT EXISTS code text NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'UNALLOCATED',
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS value_date date NULL,
  ADD COLUMN IF NOT EXISTS booking_date date NULL,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS proof_document_id uuid NULL,
  ADD COLUMN IF NOT EXISTS created_by integer NULL,
  ADD COLUMN IF NOT EXISTS workflow_status text NOT NULL DEFAULT 'RECORDED',
  ADD COLUMN IF NOT EXISTS received_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS received_by integer NULL,
  ADD COLUMN IF NOT EXISTS reversal_of_id bigint NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS request_hash text NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'paiement'
      AND column_name = 'facture_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.paiement ALTER COLUMN facture_id DROP NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiement_created_by_227_fkey' AND conrelid = 'public.paiement'::regclass) THEN
    ALTER TABLE public.paiement ADD CONSTRAINT paiement_created_by_227_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiement_proof_document_227_fkey' AND conrelid = 'public.paiement'::regclass) THEN
    ALTER TABLE public.paiement ADD CONSTRAINT paiement_proof_document_227_fkey
      FOREIGN KEY (proof_document_id) REFERENCES public.documents_clients(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_issued_by_227_fkey' AND conrelid = 'public.facture'::regclass) THEN
    ALTER TABLE public.facture ADD CONSTRAINT facture_issued_by_227_fkey
      FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'avoir_issued_by_227_fkey' AND conrelid = 'public.avoir'::regclass) THEN
    ALTER TABLE public.avoir ADD CONSTRAINT avoir_issued_by_227_fkey
      FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiement_received_by_227_fkey' AND conrelid = 'public.paiement'::regclass) THEN
    ALTER TABLE public.paiement ADD CONSTRAINT paiement_received_by_227_fkey
      FOREIGN KEY (received_by) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiement_reversal_227_fkey' AND conrelid = 'public.paiement'::regclass) THEN
    ALTER TABLE public.paiement ADD CONSTRAINT paiement_reversal_227_fkey
      FOREIGN KEY (reversal_of_id) REFERENCES public.paiement(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiement_workflow_status_227_ck' AND conrelid = 'public.paiement'::regclass) THEN
    ALTER TABLE public.paiement ADD CONSTRAINT paiement_workflow_status_227_ck
      CHECK (workflow_status IN ('RECORDED', 'ALLOCATED', 'REVERSED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paiement_status_227_ck' AND conrelid = 'public.paiement'::regclass) THEN
    ALTER TABLE public.paiement ADD CONSTRAINT paiement_status_227_ck
      CHECK (status IN ('UNALLOCATED','PARTIALLY_ALLOCATED','ALLOCATED','REJECTED','REVERSED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_issue_snapshot_227_ck' AND conrelid = 'public.facture'::regclass) THEN
    ALTER TABLE public.facture ADD CONSTRAINT facture_issue_snapshot_227_ck CHECK (
      statut <> 'ISSUED' OR (
        legal_number IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL
        AND immutable_snapshot IS NOT NULL AND document_checksum_sha256 ~ '^[A-Fa-f0-9]{64}$'
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'avoir_issue_snapshot_227_ck' AND conrelid = 'public.avoir'::regclass) THEN
    ALTER TABLE public.avoir ADD CONSTRAINT avoir_issue_snapshot_227_ck CHECK (
      statut <> 'ISSUED' OR (
        legal_number IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL
        AND immutable_snapshot IS NOT NULL AND document_checksum_sha256 ~ '^[A-Fa-f0-9]{64}$'
      )
    ) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS facture_legal_number_227_uq
  ON public.facture(legal_number) WHERE legal_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS avoir_legal_number_227_uq
  ON public.avoir(legal_number) WHERE legal_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiement_reversal_once_227_uq
  ON public.paiement(reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiement_idempotency_227_uq
  ON public.paiement(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS facture_uuid_227_uq ON public.facture(uuid) WHERE uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS facture_draft_reference_227_uq ON public.facture(draft_reference) WHERE draft_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS avoir_uuid_227_uq ON public.avoir(uuid) WHERE uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS avoir_draft_reference_227_uq ON public.avoir(draft_reference) WHERE draft_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiement_uuid_227_uq ON public.paiement(uuid) WHERE uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiement_code_227_uq ON public.paiement(code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS facture_workflow_227_idx ON public.facture(statut, issued_at DESC);

CREATE TABLE IF NOT EXISTS public.facture_echeance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  avoir_line_id bigint NULL REFERENCES public.avoir_ligne(id) ON DELETE RESTRICT,
  due_date date NOT NULL,
  label text NOT NULL,
  amount_due numeric(18,2) NOT NULL CHECK (amount_due > 0),
  amount_allocated numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount_allocated >= 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED')),
  locked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE INDEX IF NOT EXISTS facture_echeance_open_227_idx
  ON public.facture_echeance(due_date, facture_id) WHERE status IN ('OPEN','PARTIALLY_PAID','OVERDUE');

CREATE TABLE IF NOT EXISTS public.facture_source_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  facture_ligne_id bigint NOT NULL REFERENCES public.facture_ligne(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('DELIVERY_LINE','MILESTONE','DEPOSIT')),
  source_id text NOT NULL,
  source_line_id text NOT NULL,
  quantity_selected numeric(18,3) NOT NULL CHECK (quantity_selected > 0),
  quantity_consumed numeric(18,3) NOT NULL DEFAULT 0 CHECK (quantity_consumed >= 0),
  amount_ex_tax numeric(18,2) NOT NULL DEFAULT 0,
  amount_incl_tax numeric(18,2) NOT NULL DEFAULT 0,
  allocation_status text NOT NULL DEFAULT 'DRAFT' CHECK (allocation_status IN ('DRAFT','CONSUMED','REVERSED')),
  source_snapshot jsonb NOT NULL,
  rule_code text NOT NULL,
  consumed_at timestamptz NULL,
  consumed_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facture_source_allocations_227_uq UNIQUE (facture_ligne_id, source_type, source_line_id),
  CONSTRAINT facture_source_snapshot_227_ck CHECK (jsonb_typeof(source_snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS facture_source_delivery_line_227_idx
  ON public.facture_source_allocations(source_type, source_line_id, allocation_status);
CREATE INDEX IF NOT EXISTS facture_source_facture_227_idx
  ON public.facture_source_allocations(facture_id, facture_ligne_id);

CREATE TABLE IF NOT EXISTS public.paiement_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paiement_id bigint NOT NULL REFERENCES public.paiement(id) ON DELETE RESTRICT,
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  facture_due_date_id uuid NULL REFERENCES public.facture_echeance(id) ON DELETE RESTRICT,
  amount_ttc numeric(18,2) NOT NULL CHECK (amount_ttc > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT paiement_allocation_227_uq UNIQUE (paiement_id, facture_id, facture_due_date_id)
);
CREATE INDEX IF NOT EXISTS paiement_allocations_facture_227_idx
  ON public.paiement_allocations(facture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.avoir_source_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  avoir_id bigint NOT NULL REFERENCES public.avoir(id) ON DELETE RESTRICT,
  avoir_line_id bigint NULL REFERENCES public.avoir_ligne(id) ON DELETE RESTRICT,
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  facture_ligne_id bigint NULL REFERENCES public.facture_ligne(id) ON DELETE RESTRICT,
  source_type text NOT NULL DEFAULT 'INVOICE_LINE',
  source_id text NOT NULL DEFAULT '',
  source_line_id text NOT NULL DEFAULT '',
  quantity_selected numeric(18,3) NOT NULL DEFAULT 0 CHECK (quantity_selected >= 0),
  quantity_credited numeric(18,3) NOT NULL DEFAULT 0 CHECK (quantity_credited >= 0),
  amount_ttc numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount_ttc >= 0),
  allocation_status text NOT NULL DEFAULT 'DRAFT' CHECK (allocation_status IN ('DRAFT','CONSUMED','REVERSED')),
  consumed_at timestamptz NULL,
  consumed_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT avoir_source_allocations_227_uq UNIQUE (avoir_id, source_type, source_line_id)
);
CREATE INDEX IF NOT EXISTS avoir_allocations_facture_227_idx
  ON public.avoir_source_allocations(facture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('FACTURE','AVOIR','PAIEMENT')),
  aggregate_id text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_command_receipts_actor_key_227_uq UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT facturation_command_receipts_key_227_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT facturation_command_receipts_hash_227_ck CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT facturation_command_receipts_type_227_ck CHECK (char_length(command_type) BETWEEN 3 AND 120)
);
CREATE INDEX IF NOT EXISTS finance_command_receipts_resource_227_idx
  ON public.finance_command_receipts(aggregate_type, aggregate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('FACTURE', 'AVOIR', 'PAIEMENT')),
  aggregate_id text NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 120),
  old_values jsonb NULL,
  new_values jsonb NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  idempotency_key text NULL,
  rule_code text NULL,
  reason text NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_event_log_aggregate_227_idx
  ON public.finance_event_log(aggregate_type, aggregate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('FACTURE','AVOIR')),
  aggregate_id text NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents_clients(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('ISSUED','SUPERSEDED')),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0),
  mime_type text NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT finance_document_versions_document_227_uq UNIQUE (document_id),
  CONSTRAINT finance_document_versions_aggregate_227_uq UNIQUE (aggregate_type, aggregate_id, version)
);

CREATE OR REPLACE FUNCTION public.fn_protect_facturation_immutable_227()
RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION public.fn_protect_facturation_child_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_TABLE_NAME IN ('facture_ligne', 'facture_source_allocations', 'facture_echeance') THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.facture WHERE id = OLD.facture_id;
    ELSE
      SELECT statut INTO parent_status FROM public.facture WHERE id = NEW.facture_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_ligne' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.avoir WHERE id = OLD.avoir_id;
    ELSE
      SELECT statut INTO parent_status FROM public.avoir WHERE id = NEW.avoir_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.avoir WHERE id = OLD.avoir_id;
    ELSE
      SELECT statut INTO parent_status FROM public.avoir WHERE id = NEW.avoir_id;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'facture_echeance'
     AND TG_OP = 'UPDATE'
     AND parent_status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
     AND NEW.facture_id = OLD.facture_id
     AND NEW.due_date = OLD.due_date
     AND NEW.label = OLD.label
     AND NEW.amount_due = OLD.amount_due
     AND NEW.created_by = OLD.created_by
     AND NEW.amount_allocated >= OLD.amount_allocated THEN
    RETURN NEW;
  END IF;
  IF parent_status IN (
    'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
  ) THEN
    RAISE EXCEPTION 'children of issued or cancelled finance evidence are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_amount numeric(18,2);
  allocated_amount numeric(18,2);
  invoice_amount numeric(18,2);
  invoice_allocated numeric(18,2);
  credit_amount numeric(18,2);
  credit_allocated numeric(18,2);
  delivery_qty numeric(18,3);
  sourced_qty numeric(18,3);
  source_client text;
  target_client text;
BEGIN
  IF TG_TABLE_NAME = 'paiement_allocations' THEN
    SELECT montant::numeric(18,2) INTO payment_amount FROM public.paiement WHERE id = NEW.paiement_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO allocated_amount
    FROM public.paiement_allocations WHERE paiement_id = NEW.paiement_id;
    IF payment_amount IS NULL OR allocated_amount + NEW.amount_ttc > payment_amount THEN
      RAISE EXCEPTION 'payment allocations exceed recorded payment' USING ERRCODE = '23514';
    END IF;
    SELECT total_ttc::numeric(18,2) INTO invoice_amount FROM public.facture WHERE id = NEW.facture_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO invoice_allocated
    FROM public.paiement_allocations WHERE facture_id = NEW.facture_id;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO credit_allocated
    FROM public.avoir_source_allocations WHERE facture_id = NEW.facture_id;
    IF invoice_amount IS NULL OR invoice_allocated + credit_allocated + NEW.amount_ttc > invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    SELECT a.total_ttc::numeric(18,2), a.client_id, f.client_id
    INTO credit_amount, source_client, target_client
    FROM public.avoir a JOIN public.facture f ON f.id = NEW.facture_id
    WHERE a.id = NEW.avoir_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO credit_allocated
    FROM public.avoir_source_allocations WHERE avoir_id = NEW.avoir_id;
    IF source_client IS DISTINCT FROM target_client OR credit_amount IS NULL OR credit_allocated + NEW.amount_ttc > credit_amount THEN
      RAISE EXCEPTION 'credit allocation has a client mismatch or exceeds the credit note' USING ERRCODE = '23514';
    END IF;
    SELECT total_ttc::numeric(18,2) INTO invoice_amount FROM public.facture WHERE id = NEW.facture_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_ttc), 0)::numeric(18,2) INTO invoice_allocated
    FROM public.paiement_allocations WHERE facture_id = NEW.facture_id;
    IF invoice_amount IS NULL OR invoice_allocated + credit_allocated + NEW.amount_ttc > invoice_amount THEN
      RAISE EXCEPTION 'payment and credit allocations exceed invoice total' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'facture_source_allocations' THEN
    SELECT bll.quantite::numeric(18,3), bl.client_id, f.client_id
    INTO delivery_qty, source_client, target_client
    FROM public.bon_livraison_ligne bll
    JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
    JOIN public.facture f ON f.id = NEW.facture_id
    WHERE NEW.source_type = 'DELIVERY_LINE' AND bll.id::text = NEW.source_line_id
    FOR UPDATE OF bll, bl, f;
    SELECT COALESCE(SUM(quantity_selected), 0)::numeric(18,3) INTO sourced_qty
    FROM public.facture_source_allocations
    WHERE source_type = 'DELIVERY_LINE' AND source_line_id = NEW.source_line_id
      AND allocation_status IN ('DRAFT','CONSUMED');
    IF delivery_qty IS NULL OR source_client IS DISTINCT FROM target_client OR sourced_qty + NEW.quantity_selected > delivery_qty THEN
      RAISE EXCEPTION 'invoice source allocations have a client mismatch or exceed delivered quantity' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_protect_facturation_evidence_227()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'facturation audit evidence is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_protect_paiement_227()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.uuid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recorded payment evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.uuid IS DISTINCT FROM OLD.uuid
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.facture_id IS DISTINCT FROM OLD.facture_id
     OR NEW.montant IS DISTINCT FROM OLD.montant
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.date_paiement IS DISTINCT FROM OLD.date_paiement
     OR NEW.value_date IS DISTINCT FROM OLD.value_date
     OR NEW.booking_date IS DISTINCT FROM OLD.booking_date
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.commentaire IS DISTINCT FROM OLD.commentaire
     OR NEW.proof_document_id IS DISTINCT FROM OLD.proof_document_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'recorded payment identity and amount are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_facture_immutable_227 ON public.facture;
CREATE TRIGGER trg_protect_facture_immutable_227 BEFORE UPDATE OR DELETE ON public.facture
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_immutable_227();
DROP TRIGGER IF EXISTS trg_protect_avoir_immutable_227 ON public.avoir;
CREATE TRIGGER trg_protect_avoir_immutable_227 BEFORE UPDATE OR DELETE ON public.avoir
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_immutable_227();

DROP TRIGGER IF EXISTS trg_protect_facture_ligne_227 ON public.facture_ligne;
CREATE TRIGGER trg_protect_facture_ligne_227 BEFORE INSERT OR UPDATE OR DELETE ON public.facture_ligne
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_avoir_ligne_227 ON public.avoir_ligne;
CREATE TRIGGER trg_protect_avoir_ligne_227 BEFORE INSERT OR UPDATE OR DELETE ON public.avoir_ligne
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_facture_source_227 ON public.facture_source_allocations;
CREATE TRIGGER trg_protect_facture_source_227 BEFORE INSERT OR UPDATE OR DELETE ON public.facture_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_facture_echeance_227 ON public.facture_echeance;
CREATE TRIGGER trg_protect_facture_echeance_227 BEFORE INSERT OR UPDATE OR DELETE ON public.facture_echeance
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();
DROP TRIGGER IF EXISTS trg_protect_avoir_source_227 ON public.avoir_source_allocations;
CREATE TRIGGER trg_protect_avoir_source_227 BEFORE INSERT OR UPDATE OR DELETE ON public.avoir_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_child_227();

DROP TRIGGER IF EXISTS trg_validate_facture_source_allocation_227 ON public.facture_source_allocations;
CREATE TRIGGER trg_validate_facture_source_allocation_227 BEFORE INSERT ON public.facture_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP TRIGGER IF EXISTS trg_validate_paiement_allocation_227 ON public.paiement_allocations;
CREATE TRIGGER trg_validate_paiement_allocation_227 BEFORE INSERT ON public.paiement_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP TRIGGER IF EXISTS trg_validate_avoir_allocation_227 ON public.avoir_source_allocations;
CREATE TRIGGER trg_validate_avoir_allocation_227 BEFORE INSERT ON public.avoir_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP TRIGGER IF EXISTS trg_protect_paiement_227 ON public.paiement;
CREATE TRIGGER trg_protect_paiement_227 BEFORE UPDATE OR DELETE ON public.paiement
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_paiement_227();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_command_receipts', 'finance_event_log', 'finance_document_versions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_protect_' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facturation_evidence_227()', 'trg_protect_' || t, t);
  END LOOP;
END $$;

COMMENT ON TABLE public.finance_billing_policies IS
  'Issue #227 Finance policies. No active row is inserted by this patch.';
COMMENT ON TABLE public.facture_source_allocations IS
  'Invoice-source allocations. Selected quantities are locked transactionally and consumed only by explicit issue.';

COMMIT;
