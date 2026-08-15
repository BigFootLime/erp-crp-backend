-- SOL-30 — versioned industrial identifiers, print evidence and scan evidence.
-- Additive and safe to replay. The encoded payload contains only a public UUID.

BEGIN;

DO $preconditions$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-30 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'SOL-30 prerequisite relation public.users is missing';
  END IF;
END
$preconditions$;

CREATE TABLE IF NOT EXISTS public.identification_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  contract_version smallint NOT NULL DEFAULT 1,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  human_code text NOT NULL,
  site_code text NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  issued_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT now(),
  invalidated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invalidated_at timestamptz NULL,
  invalidation_reason text NULL,
  replaced_by_label_id uuid NULL REFERENCES public.identification_labels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_id text NULL,
  CONSTRAINT identification_labels_version_ck CHECK (contract_version = 1),
  CONSTRAINT identification_labels_entity_type_ck CHECK (entity_type IN (
    'STOCK_ARTICLE','STOCK_LOT','STOCK_LOCATION','WORK_ORDER','PURCHASE_ORDER',
    'RECEPTION','QUALITY_CONTROL','TOOL','DELIVERY'
  )),
  CONSTRAINT identification_labels_entity_id_ck CHECK (char_length(btrim(entity_id)) BETWEEN 1 AND 128),
  CONSTRAINT identification_labels_human_code_ck CHECK (char_length(btrim(human_code)) BETWEEN 1 AND 160),
  CONSTRAINT identification_labels_site_ck CHECK (site_code IS NULL OR char_length(btrim(site_code)) BETWEEN 1 AND 40),
  CONSTRAINT identification_labels_status_ck CHECK (status IN ('ACTIVE','INVALIDATED','REPLACED')),
  CONSTRAINT identification_labels_lifecycle_ck CHECK (
    (status = 'ACTIVE' AND invalidated_by IS NULL AND invalidated_at IS NULL AND invalidation_reason IS NULL AND replaced_by_label_id IS NULL)
    OR
    (status = 'INVALIDATED' AND invalidated_by IS NOT NULL AND invalidated_at IS NOT NULL
      AND char_length(btrim(invalidation_reason)) BETWEEN 3 AND 500 AND replaced_by_label_id IS NULL)
    OR
    (status = 'REPLACED' AND invalidated_by IS NOT NULL AND invalidated_at IS NOT NULL
      AND char_length(btrim(invalidation_reason)) BETWEEN 3 AND 500 AND replaced_by_label_id IS NOT NULL)
  ),
  CONSTRAINT identification_labels_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS identification_labels_active_entity_uq
  ON public.identification_labels(entity_type, entity_id)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS identification_labels_entity_idx
  ON public.identification_labels(entity_type, entity_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS public.identification_print_events (
  id bigserial PRIMARY KEY,
  label_id uuid NOT NULL REFERENCES public.identification_labels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type text NOT NULL,
  symbology text NOT NULL,
  label_profile text NOT NULL,
  reason text NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_id text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identification_print_type_ck CHECK (event_type IN ('PRINT','REPRINT')),
  CONSTRAINT identification_print_symbology_ck CHECK (symbology IN ('QR_CODE','CODE_128','DATA_MATRIX')),
  CONSTRAINT identification_print_profile_ck CHECK (label_profile IN ('STANDARD_50X30','SMALL_30X15','A4_SHEET')),
  CONSTRAINT identification_print_reason_ck CHECK (
    (event_type = 'PRINT' AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 500))
    OR (event_type = 'REPRINT' AND char_length(btrim(reason)) BETWEEN 3 AND 500)
  ),
  CONSTRAINT identification_print_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160)
);

CREATE INDEX IF NOT EXISTS identification_print_events_label_idx
  ON public.identification_print_events(label_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.identification_scan_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  label_id uuid NULL REFERENCES public.identification_labels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload_sha256 text NOT NULL,
  source text NOT NULL,
  flow text NOT NULL,
  expected_entity_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  result_code text NOT NULL,
  entity_type text NULL,
  entity_id text NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  client_scanned_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  request_id text NULL,
  device_id text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT identification_scan_hash_ck CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identification_scan_source_ck CHECK (source IN ('KEYBOARD','CAMERA','MANUAL','OFFLINE')),
  CONSTRAINT identification_scan_flow_ck CHECK (flow IN (
    'RECEIVE','PUTAWAY','TRANSFER','CONSUME','START_WORK_ORDER',
    'QUALITY_CONTROL','TOOL_ISSUE','TOOL_RETURN','SHIP','TRACEABILITY'
  )),
  CONSTRAINT identification_scan_result_ck CHECK (result_code IN (
    'RESOLVED','UNKNOWN','INVALIDATED','WRONG_ENTITY_TYPE','FORBIDDEN_STATUS',
    'INSUFFICIENT_PERMISSION','INVALID_PAYLOAD','ENTITY_NOT_FOUND','STALE_OFFLINE_EVENT','FUTURE_TIMESTAMP'
  )),
  CONSTRAINT identification_scan_entity_ck CHECK (
    (result_code = 'RESOLVED' AND label_id IS NOT NULL AND entity_type IS NOT NULL AND entity_id IS NOT NULL)
    OR result_code <> 'RESOLVED'
  ),
  CONSTRAINT identification_scan_types_ck CHECK (cardinality(expected_entity_types) <= 9),
  CONSTRAINT identification_scan_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160),
  CONSTRAINT identification_scan_device_ck CHECK (device_id IS NULL OR char_length(btrim(device_id)) BETWEEN 1 AND 120),
  CONSTRAINT identification_scan_details_ck CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 8192)
);

CREATE INDEX IF NOT EXISTS identification_scan_events_label_idx
  ON public.identification_scan_events(label_id, received_at DESC);
CREATE INDEX IF NOT EXISTS identification_scan_events_actor_idx
  ON public.identification_scan_events(actor_user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.identification_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  command_type text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL,
  aggregate_id text NOT NULL,
  result_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identification_receipt_command_ck CHECK (char_length(command_type) BETWEEN 2 AND 80),
  CONSTRAINT identification_receipt_hash_ck CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identification_receipt_aggregate_ck CHECK (char_length(aggregate_id) BETWEEN 1 AND 160),
  CONSTRAINT identification_receipt_result_ck CHECK (jsonb_typeof(result_payload) = 'object' AND octet_length(result_payload::text) <= 131072),
  CONSTRAINT identification_receipt_uq UNIQUE (actor_user_id, command_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.identification_audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  label_id uuid NULL REFERENCES public.identification_labels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_id text NULL,
  correlation_id text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identification_audit_action_ck CHECK (char_length(action) BETWEEN 2 AND 120),
  CONSTRAINT identification_audit_entity_ck CHECK (char_length(entity_type) BETWEEN 2 AND 80 AND char_length(entity_id) BETWEEN 1 AND 160),
  CONSTRAINT identification_audit_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160),
  CONSTRAINT identification_audit_correlation_ck CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 160),
  CONSTRAINT identification_audit_details_ck CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 32768)
);

CREATE INDEX IF NOT EXISTS identification_audit_entity_idx
  ON public.identification_audit_events(entity_type, entity_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.fn_identification_evidence_immutable_sol30()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'SOL-30 identification evidence is immutable' USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS trg_identification_print_events_immutable_sol30 ON public.identification_print_events;
CREATE TRIGGER trg_identification_print_events_immutable_sol30
BEFORE UPDATE OR DELETE ON public.identification_print_events
FOR EACH ROW EXECUTE FUNCTION public.fn_identification_evidence_immutable_sol30();

DROP TRIGGER IF EXISTS trg_identification_scan_events_immutable_sol30 ON public.identification_scan_events;
CREATE TRIGGER trg_identification_scan_events_immutable_sol30
BEFORE UPDATE OR DELETE ON public.identification_scan_events
FOR EACH ROW EXECUTE FUNCTION public.fn_identification_evidence_immutable_sol30();

DROP TRIGGER IF EXISTS trg_identification_receipts_immutable_sol30 ON public.identification_command_receipts;
CREATE TRIGGER trg_identification_receipts_immutable_sol30
BEFORE UPDATE OR DELETE ON public.identification_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_identification_evidence_immutable_sol30();

DROP TRIGGER IF EXISTS trg_identification_audit_immutable_sol30 ON public.identification_audit_events;
CREATE TRIGGER trg_identification_audit_immutable_sol30
BEFORE UPDATE OR DELETE ON public.identification_audit_events
FOR EACH ROW EXECUTE FUNCTION public.fn_identification_evidence_immutable_sol30();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.identification_labels TO cerp_app;
    GRANT SELECT, INSERT ON public.identification_print_events TO cerp_app;
    GRANT SELECT, INSERT ON public.identification_scan_events TO cerp_app;
    GRANT SELECT, INSERT ON public.identification_command_receipts TO cerp_app;
    GRANT SELECT, INSERT ON public.identification_audit_events TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.identification_print_events_id_seq TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.identification_scan_events_id_seq TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.identification_audit_events_id_seq TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
