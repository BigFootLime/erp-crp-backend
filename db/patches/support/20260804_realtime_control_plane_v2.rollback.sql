\set ON_ERROR_STOP on
BEGIN;

DO $rollback$
DECLARE
  v_inherited_v1 boolean;
  v_last_sequence bigint;
  v_pruned_through bigint;
  v_authorization_epoch bigint;
  v_baseline_event_count bigint;
  v_baseline_event_min bigint;
  v_baseline_event_max bigint;
  v_baseline_sequence_last bigint;
  v_baseline_sequence_is_called boolean;
  v_initial_last_sequence bigint;
  v_initial_pruned_through bigint;
  v_recorded_at timestamptz;
  v_current_event_count bigint;
  v_current_event_min bigint;
  v_current_event_max bigint;
  v_current_sequence_last bigint;
  v_current_sequence_is_called boolean;
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback restricted to cerp_test (current: %)', current_database();
  END IF;

  IF to_regclass('public.realtime_control_plane_v2_provenance') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refused: provenance missing';
  END IF;
  SELECT
    inherited_v1,
    baseline_event_count,
    baseline_event_min,
    baseline_event_max,
    baseline_sequence_last,
    baseline_sequence_is_called,
    initial_last_sequence,
    initial_pruned_through,
    recorded_at
  INTO
    v_inherited_v1,
    v_baseline_event_count,
    v_baseline_event_min,
    v_baseline_event_max,
    v_baseline_sequence_last,
    v_baseline_sequence_is_called,
    v_initial_last_sequence,
    v_initial_pruned_through,
    v_recorded_at
  FROM public.realtime_control_plane_v2_provenance
  WHERE singleton;
  IF v_inherited_v1 IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refused: provenance row missing';
  END IF;

  -- The DBA rollback must run first. Otherwise the remaining trigger functions
  -- would reference control-plane tables removed by this normal rollback.
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname IN (
      'users_realtime_authorization_epoch_trg',
      'app_modules_realtime_authorization_epoch_trg',
      'app_module_user_access_realtime_authorization_epoch_trg',
      'user_role_assignments_realtime_authorization_epoch_trg',
      'erp_audit_logs_realtime_outbox_trg'
    )
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refusé : exécutez d''abord db/privileged/20260804_realtime_control_plane_triggers.rollback.sql, puis relancez ce rollback';
  END IF;

  SELECT last_sequence, pruned_through
  INTO v_last_sequence, v_pruned_through
  FROM public.realtime_event_sequence_state
  WHERE singleton;
  SELECT epoch INTO v_authorization_epoch
  FROM public.realtime_authorization_epoch
  WHERE singleton;
  SELECT COUNT(*)::bigint, MIN(sequence), MAX(sequence)
  INTO v_current_event_count, v_current_event_min, v_current_event_max
  FROM public.realtime_event_log;

  IF EXISTS (SELECT 1 FROM public.realtime_chat_presence)
     OR EXISTS (SELECT 1 FROM public.realtime_stream_enqueue_state)
     OR EXISTS (SELECT 1 FROM public.realtime_event_quarantine)
     OR EXISTS (
       SELECT 1 FROM public.erp_outbox_events
       WHERE aggregate_type = 'REALTIME' OR event_type = 'REALTIME.DISPATCH'
          OR realtime_stream_id IS NOT NULL OR realtime_stream_ordinal IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.realtime_session_epochs
       WHERE updated_at >= v_recorded_at
     ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refused: v2 runtime usage/outbox evidence exists';
  END IF;

  IF v_inherited_v1 THEN
    IF to_regclass('public.realtime_event_log_sequence_seq') IS NULL THEN
      RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refused: v1 event sequence is missing';
    END IF;
    EXECUTE 'SELECT last_value::bigint, is_called FROM public.realtime_event_log_sequence_seq'
      INTO v_current_sequence_last, v_current_sequence_is_called;
    IF v_current_event_count IS DISTINCT FROM v_baseline_event_count
       OR v_current_event_min IS DISTINCT FROM v_baseline_event_min
       OR v_current_event_max IS DISTINCT FROM v_baseline_event_max
       OR v_current_sequence_last IS DISTINCT FROM v_baseline_sequence_last
       OR v_current_sequence_is_called IS DISTINCT FROM v_baseline_sequence_is_called
       OR v_last_sequence IS DISTINCT FROM v_initial_last_sequence
       OR v_pruned_through IS DISTINCT FROM v_initial_pruned_through THEN
      RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refused: inherited v1 event history changed after upgrade';
    END IF;
    PERFORM setval(
      'public.realtime_event_log_sequence_seq'::regclass,
      v_baseline_sequence_last,
      v_baseline_sequence_is_called
    );
    EXECUTE 'ALTER TABLE public.realtime_event_log ALTER COLUMN sequence SET DEFAULT nextval(''public.realtime_event_log_sequence_seq''::regclass)';
  ELSE
    IF v_current_event_count <> 0
       OR EXISTS (SELECT 1 FROM public.realtime_session_epochs)
       OR COALESCE(v_last_sequence, 0) <> 0
       OR COALESCE(v_pruned_through, 0) <> 0
       OR COALESCE(v_authorization_epoch, 0) <> 0 THEN
      RAISE EXCEPTION 'SEC-CERP-0004 v2 rollback refused: clean-v2 control-plane data/state has been used';
    END IF;
    DROP TABLE public.realtime_event_log;
    DROP TABLE public.realtime_session_epochs;
  END IF;
END
$rollback$;

DROP TABLE public.realtime_authorization_epoch;
DROP TABLE public.realtime_chat_presence;
DROP TABLE public.realtime_event_quarantine;
DROP TABLE public.realtime_stream_enqueue_state;
DROP TABLE public.realtime_event_sequence_state;
DROP TABLE public.realtime_control_plane_v2_provenance;

DROP INDEX IF EXISTS public.erp_outbox_events_realtime_ready_idx;
DROP INDEX IF EXISTS public.erp_outbox_events_realtime_stream_ordinal_uq;
ALTER TABLE public.erp_outbox_events
  DROP CONSTRAINT IF EXISTS erp_outbox_events_realtime_required_ck,
  DROP CONSTRAINT IF EXISTS erp_outbox_events_realtime_pair_ck,
  DROP COLUMN IF EXISTS realtime_stream_ordinal,
  DROP COLUMN IF EXISTS realtime_stream_id;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260804_realtime_control_plane_v2.sql';

COMMIT;
