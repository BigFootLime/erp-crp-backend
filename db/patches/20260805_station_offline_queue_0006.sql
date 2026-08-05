-- GPT56-FEAT-CERP-0006 -- bounded, resumable shop-floor offline receipts.
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL
     OR to_regclass('public.production_devices') IS NULL
     OR to_regclass('public.operator_device_sessions') IS NULL
     OR to_regclass('public.production_execution_idempotency') IS NULL
     OR to_regclass('public.production_pointages') IS NULL
     OR to_regclass('public.production_quantity_declarations') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.machines') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 prerequisite is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260805_station_offline_queue_0006.sql'
  ) THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 ledger entry already exists; use the patch runner';
  END IF;
  IF to_regclass('public.production_station_offline_config') IS NOT NULL
     OR to_regclass('public.production_station_offline_events') IS NOT NULL
     OR to_regprocedure('public.fn_purge_production_station_offline_events(integer)') IS NOT NULL
     OR to_regprocedure('public.fn_guard_production_station_offline_event()') IS NOT NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0006 target object exists without ledger provenance';
  END IF;
END
$preflight$;

CREATE TABLE public.production_station_offline_config (
  singleton boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT production_station_offline_config_pkey PRIMARY KEY (singleton),
  CONSTRAINT production_station_offline_config_singleton_ck CHECK (singleton)
);

INSERT INTO public.production_station_offline_config(singleton, enabled) VALUES (true, true);

CREATE TABLE public.production_station_offline_events (
  event_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  client_batch_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  device_id uuid NOT NULL,
  operator_user_id integer NOT NULL,
  station_session_id uuid NOT NULL,
  machine_id uuid,
  execution_session_id uuid,
  authenticated_device_id uuid NOT NULL,
  authenticated_operator_user_id integer NOT NULL,
  authenticated_station_session_id uuid NOT NULL,
  authenticated_machine_id uuid,
  payload jsonb NOT NULL,
  clock_drift_seconds bigint NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING',
  attempt_count integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  processing_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  server_entity_id uuid,
  result_payload jsonb,
  error_code text,
  error_message text,
  CONSTRAINT production_station_offline_events_pkey PRIMARY KEY (event_id),
  CONSTRAINT production_station_offline_events_idem_uq UNIQUE (idempotency_key),
  CONSTRAINT production_station_offline_events_authenticated_device_fk FOREIGN KEY (authenticated_device_id)
    REFERENCES public.production_devices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT production_station_offline_events_authenticated_user_fk FOREIGN KEY (authenticated_operator_user_id)
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT production_station_offline_events_authenticated_session_fk FOREIGN KEY (authenticated_station_session_id)
    REFERENCES public.operator_device_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT production_station_offline_events_authenticated_machine_fk FOREIGN KEY (authenticated_machine_id)
    REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT production_station_offline_events_idem_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT production_station_offline_events_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT production_station_offline_events_type_ck CHECK (
    event_type IN ('POINTAGE_START','POINTAGE_STOP','QUANTITY_DECLARE')
  ),
  CONSTRAINT production_station_offline_events_status_ck CHECK (
    status IN ('PROCESSING','SYNCED','REJECTED')
  ),
  CONSTRAINT production_station_offline_events_payload_ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT production_station_offline_events_attempt_ck CHECK (attempt_count > 0),
  CONSTRAINT production_station_offline_events_execution_session_ck CHECK (
    event_type <> 'POINTAGE_START' OR execution_session_id IS NOT NULL
  ),
  CONSTRAINT production_station_offline_events_lease_ck CHECK (lease_expires_at > received_at),
  CONSTRAINT production_station_offline_events_outcome_ck CHECK (
    (status = 'PROCESSING' AND processed_at IS NULL AND error_code IS NULL)
    OR (status = 'SYNCED' AND processed_at IS NOT NULL AND server_entity_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'REJECTED' AND processed_at IS NOT NULL AND server_entity_id IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX production_station_offline_events_device_idx
  ON public.production_station_offline_events(device_id, received_at DESC);
CREATE INDEX production_station_offline_events_status_idx
  ON public.production_station_offline_events(status, lease_expires_at);
CREATE INDEX production_station_offline_events_expiry_idx
  ON public.production_station_offline_events(expires_at)
  WHERE status IN ('SYNCED','REJECTED');

CREATE FUNCTION public.fn_guard_production_station_offline_event()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.status IN ('SYNCED','REJECTED') THEN
    RAISE EXCEPTION 'Final offline receipts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.client_batch_id IS DISTINCT FROM OLD.client_batch_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.operator_user_id IS DISTINCT FROM OLD.operator_user_id
     OR NEW.station_session_id IS DISTINCT FROM OLD.station_session_id
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.execution_session_id IS DISTINCT FROM OLD.execution_session_id
     OR NEW.authenticated_device_id IS DISTINCT FROM OLD.authenticated_device_id
     OR NEW.authenticated_operator_user_id IS DISTINCT FROM OLD.authenticated_operator_user_id
     OR NEW.authenticated_station_session_id IS DISTINCT FROM OLD.authenticated_station_session_id
     OR NEW.authenticated_machine_id IS DISTINCT FROM OLD.authenticated_machine_id
     OR NEW.payload IS DISTINCT FROM OLD.payload THEN
    RAISE EXCEPTION 'Offline receipt identity and payload are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER trg_guard_production_station_offline_event_0006
BEFORE UPDATE ON public.production_station_offline_events
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_production_station_offline_event();

CREATE FUNCTION public.fn_purge_production_station_offline_events(retention_days integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $purge$
DECLARE purged bigint;
BEGIN
  IF retention_days < 7 OR retention_days > 365 THEN
    RAISE EXCEPTION 'retention_days must be between 7 and 365';
  END IF;
  DELETE FROM public.production_station_offline_events
   WHERE status IN ('SYNCED','REJECTED')
     AND received_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$purge$;

ALTER TABLE public.production_station_offline_config OWNER TO postgres;
ALTER TABLE public.production_station_offline_events OWNER TO postgres;
ALTER FUNCTION public.fn_guard_production_station_offline_event() OWNER TO postgres;
ALTER FUNCTION public.fn_purge_production_station_offline_events(integer) OWNER TO postgres;

REVOKE ALL ON TABLE public.production_station_offline_config FROM PUBLIC, cerp_app;
GRANT SELECT ON TABLE public.production_station_offline_config TO cerp_app;
REVOKE ALL ON TABLE public.production_station_offline_events FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.production_station_offline_events TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_guard_production_station_offline_event() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_guard_production_station_offline_event() TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_purge_production_station_offline_events(integer) FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_purge_production_station_offline_events(integer) TO cerp_app;

COMMENT ON TABLE public.production_station_offline_events IS
  'GPT56-FEAT-CERP-0006 resumable receipt journal; contains no authentication material and writes no stock or quality decision.';
COMMENT ON TABLE public.production_station_offline_config IS
  'Operational database kill switch; false disables station offline synchronization without redeploying.';

COMMIT;
