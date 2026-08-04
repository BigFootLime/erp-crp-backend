\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  v_last_sequence bigint;
  v_pruned_through bigint;
  v_max_event_sequence bigint;
  v_constraint_count integer;
  v_source_v1_sha256 text;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.cerp_schema_migrations
       WHERE filename = '20260804_realtime_control_plane_v2.sql'
         AND sha256 ~ '^[0-9a-f]{64}$'
         AND applied_at IS NOT NULL
         AND applied_at <= clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: migration ledger row missing or invalid';
  END IF;

  IF to_regclass('public.realtime_control_plane_v2_provenance') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.realtime_event_log') IS NULL
     OR to_regclass('public.realtime_event_sequence_state') IS NULL
     OR to_regclass('public.realtime_authorization_epoch') IS NULL
     OR to_regclass('public.realtime_chat_presence') IS NULL
     OR to_regclass('public.realtime_stream_enqueue_state') IS NULL
     OR to_regclass('public.realtime_event_quarantine') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: control-plane relation missing';
  END IF;

  SELECT sha256
  INTO v_source_v1_sha256
  FROM public.cerp_schema_migrations
  WHERE filename = '20260804_realtime_shared_control_plane.sql'
    AND applied_at IS NOT NULL;
  IF v_source_v1_sha256 IS NOT NULL
     AND v_source_v1_sha256 <> 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6' THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: unexpected v1 ledger checksum (%)', v_source_v1_sha256;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.realtime_control_plane_v2_provenance
    WHERE (inherited_v1 AND (
             source_v1_sha256 <> 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
             OR v_source_v1_sha256 IS DISTINCT FROM source_v1_sha256
           ))
       OR (NOT inherited_v1 AND (
             source_v1_sha256 IS NOT NULL
             OR v_source_v1_sha256 IS NOT NULL
           ))
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: immutable v1 provenance mismatch';
  END IF;

  IF (SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.realtime_chat_presence'::regclass
      AND conname = ANY(ARRAY['realtime_chat_presence_expiry_ck', 'realtime_chat_presence_user_ck']::text[])
      AND convalidated) <> 2 THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: presence lease constraints missing';
  END IF;
  IF (SELECT COUNT(*) FROM pg_constraint
      WHERE conrelid = 'public.erp_outbox_events'::regclass
        AND conname = ANY(ARRAY[
          'erp_outbox_events_realtime_pair_ck',
          'erp_outbox_events_realtime_required_ck'
        ]::text[])
        AND convalidated) <> 2
     OR to_regclass('public.erp_outbox_events_realtime_stream_ordinal_uq') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: durable stream-order constraints missing';
  END IF;
  IF (SELECT COUNT(*) FROM public.realtime_control_plane_v2_provenance WHERE singleton) <> 1
     OR (SELECT COUNT(*) FROM public.realtime_event_sequence_state WHERE singleton) <> 1
     OR (SELECT COUNT(*) FROM public.realtime_authorization_epoch WHERE singleton) <> 1 THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: singleton state missing';
  END IF;

  SELECT last_sequence, pruned_through
  INTO v_last_sequence, v_pruned_through
  FROM public.realtime_event_sequence_state
  WHERE singleton;
  SELECT MAX(sequence) INTO v_max_event_sequence FROM public.realtime_event_log;
  IF v_last_sequence < COALESCE(v_max_event_sequence, 0)
     OR v_pruned_through < 0
     OR v_pruned_through > v_last_sequence THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: corrupt retention state (last=%, pruned=%, max_event=%)',
      v_last_sequence, v_pruned_through, v_max_event_sequence;
  END IF;

  IF COALESCE((
    SELECT column_default IS NULL
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'realtime_event_log'
      AND column_name = 'sequence'
  ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: legacy sequence default still installed';
  END IF;

  SELECT COUNT(*)::integer INTO v_constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.realtime_event_log'::regclass
    AND convalidated
    AND conname = ANY(ARRAY[
      'realtime_event_log_pkey',
      'realtime_event_log_event_id_uq',
      'realtime_event_log_deduplication_key_uq',
      'realtime_event_log_stream_ck',
      'realtime_event_log_name_ck',
      'realtime_event_log_targets_ck',
      'realtime_event_log_retention_ck'
    ]::text[]);
  IF v_constraint_count <> 7 THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: event-log constraints incomplete (%/7)', v_constraint_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.realtime_control_plane_v2_provenance
    WHERE baseline_event_count < 0
       OR initial_pruned_through < 0
       OR initial_pruned_through > initial_last_sequence
       OR (inherited_v1 AND source_v1_sha256 <> 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6')
       OR (NOT inherited_v1 AND source_v1_sha256 IS NOT NULL)
       OR (
         inherited_v1
         AND (
           initial_last_sequence <> initial_pruned_through
           OR initial_last_sequence <> GREATEST(
             COALESCE(baseline_event_max, 0),
             CASE
               WHEN baseline_sequence_is_called THEN baseline_sequence_last
               ELSE GREATEST(baseline_sequence_last - 1, 0)
             END
           ) + 1
           OR (baseline_event_count = 0 AND (baseline_event_min IS NOT NULL OR baseline_event_max IS NOT NULL))
           OR (baseline_event_count > 0 AND (baseline_event_min IS NULL OR baseline_event_max IS NULL OR baseline_event_min > baseline_event_max))
         )
       )
       OR (
         NOT inherited_v1
         AND (
           baseline_event_count <> 0
           OR baseline_event_min IS NOT NULL
           OR baseline_event_max IS NOT NULL
           OR baseline_sequence_last <> 1
           OR baseline_sequence_is_called
           OR initial_last_sequence <> 0
           OR initial_pruned_through <> 0
         )
       )
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: provenance inconsistent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: runtime role cerp_app missing';
  END IF;
  IF NOT has_table_privilege('cerp_app', 'public.realtime_session_epochs', 'SELECT,INSERT,UPDATE')
     OR NOT has_table_privilege('cerp_app', 'public.realtime_event_log', 'SELECT,INSERT,DELETE')
     OR NOT has_table_privilege('cerp_app', 'public.realtime_event_sequence_state', 'SELECT,INSERT,UPDATE')
     OR NOT has_table_privilege('cerp_app', 'public.realtime_authorization_epoch', 'SELECT,INSERT,UPDATE')
     OR NOT has_table_privilege('cerp_app', 'public.realtime_chat_presence', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('cerp_app', 'public.realtime_stream_enqueue_state', 'SELECT,INSERT,UPDATE')
     OR NOT has_table_privilege('cerp_app', 'public.realtime_event_quarantine', 'SELECT,INSERT,DELETE')
     OR NOT has_table_privilege('cerp_app', 'public.erp_outbox_events', 'SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 verify failed: cerp_app runtime privileges incomplete';
  END IF;
END $$;

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('realtime_control_plane_v2_provenance', 'realtime_session_epochs', 'realtime_event_log', 'realtime_event_sequence_state', 'realtime_authorization_epoch', 'realtime_chat_presence', 'realtime_stream_enqueue_state', 'realtime_event_quarantine')
ORDER BY table_name, ordinal_position;

COMMIT;
