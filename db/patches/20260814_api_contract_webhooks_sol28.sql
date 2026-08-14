-- SOL-28 — signed outbound webhooks and audited delivery control plane.
-- Additive, transactional and safe to replay. Secrets stay encrypted by an
-- application key that is never stored in PostgreSQL.

BEGIN;

DO $preconditions$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-28 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL OR to_regclass('public.erp_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'SOL-28 prerequisite relation is missing';
  END IF;
END
$preconditions$;

CREATE TABLE IF NOT EXISTS public.api_webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  endpoint_url text NOT NULL,
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  secret_ciphertext text NOT NULL,
  secret_iv text NOT NULL,
  secret_tag text NOT NULL,
  secret_hint text NOT NULL,
  secret_version integer NOT NULL DEFAULT 1,
  consecutive_failure_count integer NOT NULL DEFAULT 0,
  disabled_reason text NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_subscription_name_ck CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT api_webhook_subscription_endpoint_ck CHECK (char_length(endpoint_url) BETWEEN 8 AND 2048),
  CONSTRAINT api_webhook_subscription_events_ck CHECK (cardinality(event_types) BETWEEN 1 AND 20),
  CONSTRAINT api_webhook_subscription_status_ck CHECK (status IN ('ACTIVE','PAUSED','DISABLED')),
  CONSTRAINT api_webhook_subscription_secret_ck CHECK (
    char_length(secret_ciphertext) BETWEEN 20 AND 2048
    AND char_length(secret_iv) BETWEEN 12 AND 128
    AND char_length(secret_tag) BETWEEN 12 AND 128
    AND char_length(secret_hint) BETWEEN 4 AND 24
    AND secret_version > 0
  ),
  CONSTRAINT api_webhook_subscription_failures_ck CHECK (consecutive_failure_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_subscriptions_name_uq
  ON public.api_webhook_subscriptions(lower(name));
CREATE INDEX IF NOT EXISTS api_webhook_subscriptions_status_idx
  ON public.api_webhook_subscriptions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.api_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_outbox_id uuid NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_event_type_ck CHECK (event_type ~ '^erp\.[a-z0-9.-]+\.v[1-9][0-9]*$'),
  CONSTRAINT api_webhook_event_aggregate_ck CHECK (
    char_length(aggregate_type) BETWEEN 1 AND 80 AND char_length(aggregate_id) BETWEEN 1 AND 160
  ),
  CONSTRAINT api_webhook_event_payload_ck CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144
  ),
  CONSTRAINT api_webhook_event_hash_ck CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_events_source_uq
  ON public.api_webhook_events(source_outbox_id) WHERE source_outbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_webhook_events_type_occurred_idx
  ON public.api_webhook_events(event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.api_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.api_webhook_subscriptions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES public.api_webhook_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  replay_of_delivery_id uuid NULL REFERENCES public.api_webhook_deliveries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid NULL,
  lease_expires_at timestamptz NULL,
  last_http_status integer NULL,
  last_error_code text NULL,
  response_fingerprint text NULL,
  delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_delivery_status_ck CHECK (
    status IN ('PENDING','PROCESSING','RETRY','DELIVERED','DEAD_LETTER','CANCELLED')
  ),
  CONSTRAINT api_webhook_delivery_attempt_ck CHECK (attempt_count BETWEEN 0 AND 8),
  CONSTRAINT api_webhook_delivery_lease_ck CHECK (
    (status = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT api_webhook_delivery_http_ck CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  CONSTRAINT api_webhook_delivery_error_ck CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 120),
  CONSTRAINT api_webhook_delivery_fingerprint_ck CHECK (
    response_fingerprint IS NULL OR response_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_deliveries_original_uq
  ON public.api_webhook_deliveries(subscription_id, event_id)
  WHERE replay_of_delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS api_webhook_deliveries_due_idx
  ON public.api_webhook_deliveries(status, next_attempt_at, created_at)
  WHERE status IN ('PENDING','RETRY','PROCESSING');
CREATE INDEX IF NOT EXISTS api_webhook_deliveries_subscription_idx
  ON public.api_webhook_deliveries(subscription_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.api_webhook_delivery_attempts (
  id bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES public.api_webhook_deliveries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  outcome text NOT NULL,
  http_status integer NULL,
  error_code text NULL,
  duration_ms integer NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_attempt_number_ck CHECK (attempt_number BETWEEN 1 AND 8),
  CONSTRAINT api_webhook_attempt_outcome_ck CHECK (outcome IN ('DELIVERED','RETRY','DEAD_LETTER')),
  CONSTRAINT api_webhook_attempt_http_ck CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT api_webhook_attempt_error_ck CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 120),
  CONSTRAINT api_webhook_attempt_duration_ck CHECK (duration_ms BETWEEN 0 AND 120000),
  CONSTRAINT api_webhook_attempt_unique UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS api_webhook_attempts_delivery_idx
  ON public.api_webhook_delivery_attempts(delivery_id, attempt_number DESC);

CREATE TABLE IF NOT EXISTS public.api_webhook_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_receipt_action_ck CHECK (char_length(action) BETWEEN 1 AND 80),
  CONSTRAINT api_webhook_receipt_hash_ck CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_webhook_receipt_result_ck CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT api_webhook_receipt_unique UNIQUE (actor_id, action, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.api_webhook_audit_events (
  id bigserial PRIMARY KEY,
  actor_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  request_id text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_audit_action_ck CHECK (char_length(action) BETWEEN 1 AND 120),
  CONSTRAINT api_webhook_audit_entity_ck CHECK (
    char_length(entity_type) BETWEEN 1 AND 80 AND char_length(entity_id) BETWEEN 1 AND 160
  ),
  CONSTRAINT api_webhook_audit_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160),
  CONSTRAINT api_webhook_audit_details_ck CHECK (
    jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 32768
  )
);

CREATE INDEX IF NOT EXISTS api_webhook_audit_entity_idx
  ON public.api_webhook_audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.api_webhook_ingestion_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_outbox_created_at timestamptz NOT NULL,
  last_outbox_id uuid NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.api_webhook_ingestion_state(singleton, last_outbox_created_at, last_outbox_id)
SELECT true, seed.created_at, seed.id
FROM (
  SELECT created_at, id
  FROM public.erp_outbox_events
  ORDER BY created_at DESC, id DESC
  LIMIT 1
) seed
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO public.api_webhook_ingestion_state(singleton, last_outbox_created_at, last_outbox_id)
SELECT true, '-infinity'::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid
WHERE NOT EXISTS (SELECT 1 FROM public.api_webhook_ingestion_state)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_api_webhook_evidence_immutable_sol28()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'SOL-28 webhook evidence is immutable' USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_webhook_attempts_immutable_sol28 ON public.api_webhook_delivery_attempts;
CREATE TRIGGER trg_api_webhook_attempts_immutable_sol28
BEFORE UPDATE OR DELETE ON public.api_webhook_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION public.fn_api_webhook_evidence_immutable_sol28();

DROP TRIGGER IF EXISTS trg_api_webhook_receipts_immutable_sol28 ON public.api_webhook_command_receipts;
CREATE TRIGGER trg_api_webhook_receipts_immutable_sol28
BEFORE UPDATE OR DELETE ON public.api_webhook_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_api_webhook_evidence_immutable_sol28();

DROP TRIGGER IF EXISTS trg_api_webhook_audit_immutable_sol28 ON public.api_webhook_audit_events;
CREATE TRIGGER trg_api_webhook_audit_immutable_sol28
BEFORE UPDATE OR DELETE ON public.api_webhook_audit_events
FOR EACH ROW EXECUTE FUNCTION public.fn_api_webhook_evidence_immutable_sol28();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.api_webhook_subscriptions TO cerp_app;
    GRANT SELECT, INSERT ON public.api_webhook_events TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.api_webhook_deliveries TO cerp_app;
    GRANT SELECT, INSERT ON public.api_webhook_delivery_attempts TO cerp_app;
    GRANT SELECT, INSERT ON public.api_webhook_command_receipts TO cerp_app;
    GRANT SELECT, INSERT ON public.api_webhook_audit_events TO cerp_app;
    GRANT SELECT, UPDATE ON public.api_webhook_ingestion_state TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.api_webhook_delivery_attempts_id_seq TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.api_webhook_audit_events_id_seq TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
