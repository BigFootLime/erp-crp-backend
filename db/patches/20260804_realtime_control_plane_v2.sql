-- SEC-CERP-0004 v2 - owner-safe shared Socket.IO control plane.
-- This supersedes the pushed v1 patch. The patch runner ignores the orphaned
-- v1 ledger entry on databases that already applied it, while a clean database
-- can install this file without CREATE TRIGGER privileges on business tables.

BEGIN;

-- Record whether this database is an upgrade from the already-published v1
-- patch before creating any v2 relation. Rollback uses this durable provenance
-- to restore v1 instead of deleting objects that v1 owns.
CREATE TABLE IF NOT EXISTS public.realtime_control_plane_v2_provenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  inherited_v1 boolean NOT NULL,
  source_v1_sha256 text,
  baseline_event_count bigint NOT NULL,
  baseline_event_min bigint,
  baseline_event_max bigint,
  baseline_sequence_last bigint NOT NULL,
  baseline_sequence_is_called boolean NOT NULL,
  initial_last_sequence bigint NOT NULL,
  initial_pruned_through bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT realtime_control_plane_v2_source_ck CHECK (
    (inherited_v1 AND source_v1_sha256 = 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6')
    OR (NOT inherited_v1 AND source_v1_sha256 IS NULL)
  )
);

DO $provenance$
DECLARE
  v_has_ledger boolean;
  v_source_v1_sha256 text;
  v_has_sessions boolean := to_regclass('public.realtime_session_epochs') IS NOT NULL;
  v_has_events boolean := to_regclass('public.realtime_event_log') IS NOT NULL;
  v_has_sequence boolean := to_regclass('public.realtime_event_log_sequence_seq') IS NOT NULL;
  v_count bigint := 0;
  v_min bigint;
  v_max bigint;
  v_sequence_last bigint := 1;
  v_sequence_is_called boolean := false;
  v_allocated_through bigint := 0;
  v_initial_last bigint := 0;
  v_initial_pruned bigint := 0;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    v_has_ledger := false;
  ELSE
    SELECT sha256
    INTO v_source_v1_sha256
    FROM public.cerp_schema_migrations
    WHERE filename = '20260804_realtime_shared_control_plane.sql'
      AND applied_at IS NOT NULL;
    IF v_source_v1_sha256 IS NOT NULL
       AND v_source_v1_sha256 <> 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6' THEN
      RAISE EXCEPTION 'SEC-CERP-0004 v2 refused: unexpected v1 ledger checksum (%)', v_source_v1_sha256;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.cerp_schema_migrations
      WHERE filename = '20260804_realtime_shared_control_plane.sql'
        AND sha256 = 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
        AND applied_at IS NOT NULL
    ) INTO v_has_ledger;
  END IF;

  -- Fail closed on partial/manual states. The only supported starting points
  -- are a completely clean database or the complete runner-recorded v1.
  IF NOT (
    (NOT v_has_ledger AND NOT v_has_sessions AND NOT v_has_events AND NOT v_has_sequence)
    OR (v_has_ledger AND v_has_sessions AND v_has_events AND v_has_sequence)
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 refused: ambiguous partial v1 state (ledger=%, sessions=%, events=%, sequence=%)',
      v_has_ledger, v_has_sessions, v_has_events, v_has_sequence;
  END IF;

  IF v_has_ledger THEN
    EXECUTE 'SELECT COUNT(*)::bigint, MIN(sequence), MAX(sequence) FROM public.realtime_event_log'
      INTO v_count, v_min, v_max;
    EXECUTE 'SELECT last_value::bigint, is_called FROM public.realtime_event_log_sequence_seq'
      INTO v_sequence_last, v_sequence_is_called;
    v_allocated_through := CASE
      WHEN v_sequence_is_called THEN v_sequence_last
      ELSE GREATEST(v_sequence_last - 1, 0)
    END;
    -- V1 had no durable prune watermark. MIN(sequence)-1 would only prove a
    -- purged prefix and would miss internal/tail gaps (for example 1, 100 with
    -- sequence 50 already expired). Reserve one sequence that V1 could never
    -- have exposed and use it as a replay barrier: every cursor issued by V1
    -- is then strictly below pruned_through and must bootstrap/refetch once.
    IF GREATEST(COALESCE(v_max, 0), v_allocated_through) = 9223372036854775807 THEN
      RAISE EXCEPTION 'SEC-CERP-0004 v2 refused: no bigint sequence remains for the v1 replay barrier';
    END IF;
    v_initial_last := GREATEST(COALESCE(v_max, 0), v_allocated_through) + 1;
    v_initial_pruned := v_initial_last;
  END IF;

  INSERT INTO public.realtime_control_plane_v2_provenance (
    singleton,
    inherited_v1,
    source_v1_sha256,
    baseline_event_count,
    baseline_event_min,
    baseline_event_max,
    baseline_sequence_last,
    baseline_sequence_is_called,
    initial_last_sequence,
    initial_pruned_through
  ) VALUES (
    true,
    v_has_ledger,
    CASE WHEN v_has_ledger THEN 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6' END,
    v_count,
    v_min,
    v_max,
    v_sequence_last,
    v_sequence_is_called,
    v_initial_last,
    v_initial_pruned
  )
  ON CONFLICT (singleton) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.realtime_control_plane_v2_provenance
    WHERE singleton
      AND inherited_v1 = v_has_ledger
      AND source_v1_sha256 IS NOT DISTINCT FROM CASE
        WHEN v_has_ledger THEN 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
      END
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 refused: existing provenance does not match the immutable v1 ledger';
  END IF;
END
$provenance$;

CREATE TABLE IF NOT EXISTS public.realtime_session_epochs (
  user_id bigint PRIMARY KEY,
  session_epoch bigint NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.realtime_event_log (
  sequence bigint PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  deduplication_key text NOT NULL,
  stream_id text NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  targets jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  CONSTRAINT realtime_event_log_event_id_uq UNIQUE (event_id),
  CONSTRAINT realtime_event_log_deduplication_key_uq UNIQUE (deduplication_key),
  CONSTRAINT realtime_event_log_stream_ck CHECK (btrim(stream_id) <> '' AND length(stream_id) <= 256),
  CONSTRAINT realtime_event_log_name_ck CHECK (btrim(event_name) <> '' AND length(event_name) <= 128),
  CONSTRAINT realtime_event_log_targets_ck CHECK (jsonb_typeof(targets) = 'array' AND jsonb_array_length(targets) > 0),
  CONSTRAINT realtime_event_log_retention_ck CHECK (expires_at > occurred_at)
);

-- Upgrade from pushed v1: remove the bigserial default before any v2 runtime
-- starts. Old and new allocators must never overlap, so this migration requires
-- a drained/stopped v1 runtime (it is intentionally not rolling-compatible).
DO $$
BEGIN
  IF (SELECT column_default IS NOT NULL
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'realtime_event_log'
        AND column_name = 'sequence') THEN
    ALTER TABLE public.realtime_event_log ALTER COLUMN sequence DROP DEFAULT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS realtime_event_log_expires_idx
  ON public.realtime_event_log (expires_at, sequence);
CREATE INDEX IF NOT EXISTS realtime_event_log_stream_sequence_idx
  ON public.realtime_event_log (stream_id, sequence);

CREATE TABLE IF NOT EXISTS public.realtime_event_sequence_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  pruned_through bigint NOT NULL DEFAULT 0 CHECK (pruned_through >= 0)
);

INSERT INTO public.realtime_event_sequence_state (singleton, last_sequence, pruned_through)
SELECT true, initial_last_sequence, initial_pruned_through
FROM public.realtime_control_plane_v2_provenance
WHERE singleton
ON CONFLICT (singleton) DO UPDATE
SET last_sequence = GREATEST(
  public.realtime_event_sequence_state.last_sequence,
  EXCLUDED.last_sequence
),
pruned_through = GREATEST(
  public.realtime_event_sequence_state.pruned_through,
  EXCLUDED.pruned_through
);

CREATE TABLE IF NOT EXISTS public.realtime_authorization_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.realtime_authorization_epoch (singleton, epoch)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

-- One leased row per Socket.IO connection and application node. This is
-- deliberately separate from session epochs: presence is ephemeral, while
-- session revocation is durable security state.
CREATE TABLE IF NOT EXISTS public.realtime_chat_presence (
  node_id text NOT NULL CHECK (btrim(node_id) <> '' AND length(node_id) <= 128),
  connection_id text NOT NULL CHECK (btrim(connection_id) <> '' AND length(connection_id) <= 256),
  user_id bigint NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, connection_id),
  CONSTRAINT realtime_chat_presence_user_ck CHECK (user_id > 0),
  CONSTRAINT realtime_chat_presence_expiry_ck CHECK (expires_at > last_seen_at)
);
CREATE INDEX IF NOT EXISTS realtime_chat_presence_user_expiry_idx
  ON public.realtime_chat_presence (user_id, expires_at);
CREATE INDEX IF NOT EXISTS realtime_chat_presence_expiry_idx
  ON public.realtime_chat_presence (expires_at);

-- Realtime outbox order is allocated durably inside the business transaction.
-- The runtime also takes one transaction-scoped advisory lock before allocation:
-- this intentionally serializes enqueue allocation (CERP's mutation throughput is
-- modest) and prevents A->B / B->A multi-stream transactions from deadlocking.
CREATE TABLE IF NOT EXISTS public.realtime_stream_enqueue_state (
  stream_id text PRIMARY KEY,
  next_ordinal bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT realtime_stream_enqueue_state_stream_ck
    CHECK (btrim(stream_id) <> '' AND length(stream_id) <= 256),
  CONSTRAINT realtime_stream_enqueue_state_ordinal_ck CHECK (next_ordinal > 0)
);

-- Keep the main migration fail-closed even when an operator bypasses the
-- companion preflight. A malformed v1 row must never survive as an unordered
-- realtime row and then fail later while constraints are being validated.
DO $legacy_realtime_outbox_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.erp_outbox_events
    WHERE aggregate_type = 'REALTIME'
      AND event_type = 'REALTIME.DISPATCH'
      AND (
        COALESCE(NULLIF(btrim(payload #>> '{input,streamId}'), ''), NULLIF(btrim(aggregate_id), '')) IS NULL
        OR length(COALESCE(NULLIF(btrim(payload #>> '{input,streamId}'), ''), NULLIF(btrim(aggregate_id), ''))) > 256
      )
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 refused: legacy realtime outbox stream cannot be backfilled safely';
  END IF;
END
$legacy_realtime_outbox_guard$;

ALTER TABLE public.erp_outbox_events
  ADD COLUMN IF NOT EXISTS realtime_stream_id text,
  ADD COLUMN IF NOT EXISTS realtime_stream_ordinal bigint;

-- A stopped v1 or interrupted pre-v2 deployment can have pending realtime rows.
-- Backfill their durable order once, using the pre-existing enqueue chronology.
WITH ranked AS (
  SELECT
    id,
    COALESCE(NULLIF(btrim(payload #>> '{input,streamId}'), ''), NULLIF(btrim(aggregate_id), '')) AS stream_id,
    row_number() OVER (
      PARTITION BY COALESCE(NULLIF(btrim(payload #>> '{input,streamId}'), ''), NULLIF(btrim(aggregate_id), ''))
      ORDER BY created_at, id
    )::bigint AS stream_ordinal
  FROM public.erp_outbox_events
  WHERE aggregate_type = 'REALTIME'
    AND event_type = 'REALTIME.DISPATCH'
    AND (realtime_stream_id IS NULL OR realtime_stream_ordinal IS NULL)
)
UPDATE public.erp_outbox_events outbox
SET realtime_stream_id = ranked.stream_id,
    realtime_stream_ordinal = ranked.stream_ordinal
FROM ranked
WHERE ranked.id = outbox.id
  AND ranked.stream_id IS NOT NULL
  AND length(ranked.stream_id) <= 256;

INSERT INTO public.realtime_stream_enqueue_state (stream_id, next_ordinal)
SELECT realtime_stream_id, MAX(realtime_stream_ordinal) + 1
FROM public.erp_outbox_events
WHERE realtime_stream_id IS NOT NULL
  AND realtime_stream_ordinal IS NOT NULL
GROUP BY realtime_stream_id
ON CONFLICT (stream_id) DO UPDATE
SET next_ordinal = GREATEST(
      public.realtime_stream_enqueue_state.next_ordinal,
      EXCLUDED.next_ordinal
    ),
    updated_at = clock_timestamp();

CREATE UNIQUE INDEX IF NOT EXISTS erp_outbox_events_realtime_stream_ordinal_uq
  ON public.erp_outbox_events (realtime_stream_id, realtime_stream_ordinal)
  WHERE realtime_stream_id IS NOT NULL AND realtime_stream_ordinal IS NOT NULL;
CREATE INDEX IF NOT EXISTS erp_outbox_events_realtime_ready_idx
  ON public.erp_outbox_events (status, available_at, realtime_stream_id, realtime_stream_ordinal)
  WHERE aggregate_type = 'REALTIME' AND event_type = 'REALTIME.DISPATCH';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_outbox_events_realtime_pair_ck'
                 AND conrelid = 'public.erp_outbox_events'::regclass) THEN
    ALTER TABLE public.erp_outbox_events
      ADD CONSTRAINT erp_outbox_events_realtime_pair_ck CHECK (
        (realtime_stream_id IS NULL AND realtime_stream_ordinal IS NULL)
        OR
        (realtime_stream_id IS NOT NULL AND btrim(realtime_stream_id) <> ''
          AND length(realtime_stream_id) <= 256 AND realtime_stream_ordinal > 0)
      ) NOT VALID;
    ALTER TABLE public.erp_outbox_events VALIDATE CONSTRAINT erp_outbox_events_realtime_pair_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_outbox_events_realtime_required_ck'
                 AND conrelid = 'public.erp_outbox_events'::regclass) THEN
    ALTER TABLE public.erp_outbox_events
      ADD CONSTRAINT erp_outbox_events_realtime_required_ck CHECK (
        aggregate_type <> 'REALTIME'
        OR event_type <> 'REALTIME.DISPATCH'
        OR (realtime_stream_id IS NOT NULL AND realtime_stream_ordinal IS NOT NULL)
      ) NOT VALID;
    ALTER TABLE public.erp_outbox_events VALIDATE CONSTRAINT erp_outbox_events_realtime_required_ck;
  END IF;
END $$;

-- Quarantine contains only bounded, privacy-safe forensic metadata (never the
-- business payload). A poisoned row is remediated into a full-resync barrier so
-- no client can ACK a cursor beyond an unprocessed gap.
CREATE TABLE IF NOT EXISTS public.realtime_event_quarantine (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  source_id text NOT NULL,
  sequence bigint,
  reason text NOT NULL,
  content_hash text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
  CONSTRAINT realtime_event_quarantine_source_ck CHECK (source IN ('event_log', 'outbox')),
  CONSTRAINT realtime_event_quarantine_source_id_ck CHECK (btrim(source_id) <> '' AND length(source_id) <= 256),
  CONSTRAINT realtime_event_quarantine_reason_ck CHECK (reason ~ '^[A-Z0-9_]{1,96}$'),
  CONSTRAINT realtime_event_quarantine_hash_ck CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT realtime_event_quarantine_sequence_ck CHECK (sequence IS NULL OR sequence > 0),
  CONSTRAINT realtime_event_quarantine_retention_ck CHECK (expires_at > quarantined_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS realtime_event_quarantine_identity_uq
  ON public.realtime_event_quarantine (source, source_id, reason);
CREATE INDEX IF NOT EXISTS realtime_event_quarantine_expiry_idx
  ON public.realtime_event_quarantine (expires_at, id);

-- No trigger is created here: hardened business/audit tables can be owned by
-- postgres. Known application writers bump epochs/outbox explicitly in their
-- own transaction. The mandatory privileged deployment script installs the
-- cross-writer backstops required by runtime readiness.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_session_epochs'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE ON public.realtime_session_epochs TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_event_log'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.realtime_event_log TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_event_sequence_state'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE ON public.realtime_event_sequence_state TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_authorization_epoch'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE ON public.realtime_authorization_epoch TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_chat_presence'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.realtime_chat_presence TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_stream_enqueue_state'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE ON public.realtime_stream_enqueue_state TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.realtime_event_quarantine'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, DELETE ON public.realtime_event_quarantine TO cerp_app;
      GRANT USAGE, SELECT ON SEQUENCE public.realtime_event_quarantine_id_seq TO cerp_app;
    END IF;
    IF COALESCE((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                 FROM pg_class c WHERE c.oid = 'public.erp_outbox_events'::regclass), false)
       OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      GRANT SELECT, INSERT, UPDATE ON public.erp_outbox_events TO cerp_app;
    END IF;
  END IF;
END $$;

COMMIT;
