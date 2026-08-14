-- SOL-26 — provider-independent electronic invoicing boundary.
-- Additive and replay-safe. It stores hashes, identifiers and normalized lifecycle
-- evidence; invoice payloads, credentials and attachment bytes remain outside SQL.

BEGIN;

CREATE TABLE IF NOT EXISTS public.einvoice_provider_connections (
  provider_code text PRIMARY KEY,
  adapter_key text NOT NULL,
  environment text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  supported_formats text[] NOT NULL DEFAULT ARRAY[]::text[],
  credential_reference jsonb NOT NULL DEFAULT '{}'::jsonb,
  qualified_at timestamptz NULL,
  qualified_by integer NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_provider_code_sol26_ck CHECK (provider_code ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  CONSTRAINT einvoice_provider_adapter_sol26_ck CHECK (adapter_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  CONSTRAINT einvoice_provider_environment_sol26_ck CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT einvoice_provider_formats_sol26_ck CHECK (
    supported_formats <@ ARRAY['UBL','CII','FACTUR_X']::text[]
  ),
  CONSTRAINT einvoice_provider_qualified_sol26_ck CHECK (
    enabled = false OR (qualified_at IS NOT NULL AND qualified_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS einvoice_one_active_environment_sol26_uq
  ON public.einvoice_provider_connections(environment)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS public.einvoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL,
  document_type text NOT NULL,
  format text NOT NULL,
  facture_id bigint NULL REFERENCES public.facture(id),
  avoir_id bigint NULL REFERENCES public.avoir(id),
  provider_code text NOT NULL REFERENCES public.einvoice_provider_connections(provider_code),
  provider_document_id text NULL,
  source_sha256 text NOT NULL,
  content_sha256 text NULL,
  content_storage_reference text NULL,
  attachment_metadata jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_status_code smallint NULL,
  external_status_at timestamptz NULL,
  filing_proof_reference text NULL,
  filing_proof_sha256 text NULL,
  last_error_code text NULL,
  last_error_message text NULL,
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz NULL,
  processing_token uuid NULL,
  processing_started_at timestamptz NULL,
  correlation_id uuid NOT NULL,
  created_by integer NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_document_direction_sol26_ck CHECK (direction IN ('OUTBOUND','INBOUND')),
  CONSTRAINT einvoice_document_type_sol26_ck CHECK (document_type IN ('INVOICE','CREDIT_NOTE')),
  CONSTRAINT einvoice_document_format_sol26_ck CHECK (format IN ('UBL','CII','FACTUR_X')),
  CONSTRAINT einvoice_document_source_hash_sol26_ck CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT einvoice_document_hash_sol26_ck CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT einvoice_document_attachment_metadata_sol26_ck CHECK (
    jsonb_typeof(attachment_metadata) = 'array'
  ),
  CONSTRAINT einvoice_document_proof_hash_sol26_ck CHECK (
    filing_proof_sha256 IS NULL OR filing_proof_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT einvoice_document_status_sol26_ck CHECK (
    external_status_code IS NULL OR external_status_code BETWEEN 200 AND 213
  ),
  CONSTRAINT einvoice_document_processing_sol26_ck CHECK (
    (processing_token IS NULL) = (processing_started_at IS NULL)
  ),
  CONSTRAINT einvoice_document_outbound_source_sol26_ck CHECK (
    direction <> 'OUTBOUND' OR ((facture_id IS NOT NULL)::int + (avoir_id IS NOT NULL)::int = 1)
  ),
  CONSTRAINT einvoice_document_provider_id_sol26_uq UNIQUE (provider_code, provider_document_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS einvoice_outbound_facture_sol26_uq
  ON public.einvoice_documents(facture_id)
  WHERE direction = 'OUTBOUND' AND facture_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS einvoice_outbound_avoir_sol26_uq
  ON public.einvoice_documents(avoir_id)
  WHERE direction = 'OUTBOUND' AND avoir_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS einvoice_retry_queue_sol26_idx
  ON public.einvoice_documents(next_retry_at, created_at)
  WHERE next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.einvoice_submission_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.einvoice_documents(id),
  operation text NOT NULL,
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  provider_request_id text NULL,
  http_status integer NULL,
  retryable boolean NOT NULL DEFAULT false,
  error_code text NULL,
  error_message text NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  next_retry_at timestamptz NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_attempt_operation_sol26_ck CHECK (operation IN ('SUBMIT','RECONCILE')),
  CONSTRAINT einvoice_attempt_no_sol26_ck CHECK (attempt_no > 0),
  CONSTRAINT einvoice_attempt_outcome_sol26_ck CHECK (outcome IN ('SUCCEEDED','FAILED')),
  CONSTRAINT einvoice_attempt_http_sol26_ck CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT einvoice_attempt_time_sol26_ck CHECK (finished_at >= started_at),
  CONSTRAINT einvoice_attempt_document_no_sol26_uq UNIQUE (document_id, operation, attempt_no)
);

CREATE INDEX IF NOT EXISTS einvoice_attempt_document_sol26_idx
  ON public.einvoice_submission_attempts(document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.einvoice_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.einvoice_documents(id),
  provider_code text NOT NULL REFERENCES public.einvoice_provider_connections(provider_code),
  provider_event_id text NOT NULL,
  provider_payload_sha256 text NOT NULL,
  external_status_code smallint NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  rejection_code text NULL,
  rejection_message text NULL,
  signature_verified boolean NULL,
  filing_proof_reference text NULL,
  filing_proof_sha256 text NULL,
  correlation_id uuid NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_event_status_sol26_ck CHECK (external_status_code BETWEEN 200 AND 213),
  CONSTRAINT einvoice_event_payload_hash_sol26_ck CHECK (provider_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT einvoice_event_proof_hash_sol26_ck CHECK (
    filing_proof_sha256 IS NULL OR filing_proof_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT einvoice_event_provider_id_sol26_uq UNIQUE (provider_code, provider_event_id)
);

CREATE INDEX IF NOT EXISTS einvoice_event_document_sol26_idx
  ON public.einvoice_provider_events(document_id, occurred_at DESC, received_at DESC);

CREATE TABLE IF NOT EXISTS public.einvoice_command_receipts (
  actor_user_id integer NOT NULL REFERENCES public.users(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  document_id uuid NULL REFERENCES public.einvoice_documents(id),
  result_payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key),
  CONSTRAINT einvoice_receipt_hash_sol26_ck CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION public.fn_einvoice_evidence_append_only_sol26()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'SOL-26 electronic-invoice evidence is append-only'
    USING ERRCODE = 'P2626';
END
$function$;

DROP TRIGGER IF EXISTS trg_einvoice_attempt_append_only_sol26 ON public.einvoice_submission_attempts;
CREATE TRIGGER trg_einvoice_attempt_append_only_sol26
BEFORE UPDATE OR DELETE ON public.einvoice_submission_attempts
FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_evidence_append_only_sol26();

DROP TRIGGER IF EXISTS trg_einvoice_event_append_only_sol26 ON public.einvoice_provider_events;
CREATE TRIGGER trg_einvoice_event_append_only_sol26
BEFORE UPDATE OR DELETE ON public.einvoice_provider_events
FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_evidence_append_only_sol26();

DROP TRIGGER IF EXISTS trg_einvoice_receipt_append_only_sol26 ON public.einvoice_command_receipts;
CREATE TRIGGER trg_einvoice_receipt_append_only_sol26
BEFORE UPDATE OR DELETE ON public.einvoice_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_evidence_append_only_sol26();

COMMENT ON TABLE public.einvoice_provider_connections IS
  'SOL-26 connector metadata only. credential_reference contains secret manager or environment variable names, never secret values.';
COMMENT ON TABLE public.einvoice_documents IS
  'SOL-26 normalized reconciliation state. External status is restricted to DGFiP V3.2 invoice lifecycle codes 200-213.';
COMMENT ON TABLE public.einvoice_provider_events IS
  'SOL-26 append-only minimized provider evidence. Raw invoice content and raw webhook bodies are not persisted.';

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.einvoice_provider_connections TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.einvoice_documents TO cerp_app;
    GRANT SELECT, INSERT ON public.einvoice_submission_attempts TO cerp_app;
    GRANT SELECT, INSERT ON public.einvoice_provider_events TO cerp_app;
    GRANT SELECT, INSERT ON public.einvoice_command_receipts TO cerp_app;
  END IF;
END
$grant$;

COMMIT;
