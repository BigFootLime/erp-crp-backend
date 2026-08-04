\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  v_has_ledger boolean;
  v_source_v1_sha256 text;
  v_has_sessions boolean := to_regclass('public.realtime_session_epochs') IS NOT NULL;
  v_has_events boolean := to_regclass('public.realtime_event_log') IS NOT NULL;
  v_has_sequence boolean := to_regclass('public.realtime_event_log_sequence_seq') IS NOT NULL;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.user_role_assignments') IS NULL
     OR to_regclass('public.app_modules') IS NULL
     OR to_regclass('public.app_module_user_access') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regclass('public.erp_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: prerequisite relation missing';
  END IF;
  IF NOT has_table_privilege(current_user, 'public.erp_outbox_events', 'SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: runtime outbox privileges missing';
  END IF;
  IF NOT COALESCE((
       SELECT relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       FROM pg_class WHERE oid = 'public.erp_outbox_events'::regclass
     ), false)
     AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: current user must own erp_outbox_events to add durable ordering columns';
  END IF;
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
    RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: legacy realtime outbox stream cannot be backfilled safely';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pg_function_is_visible(oid)
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: gen_random_uuid unavailable';
  END IF;
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
      RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: unexpected v1 ledger checksum (%)', v_source_v1_sha256;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.cerp_schema_migrations
      WHERE filename = '20260804_realtime_shared_control_plane.sql'
        AND sha256 = 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
        AND applied_at IS NOT NULL
    ) INTO v_has_ledger;
  END IF;
  IF NOT (
    (NOT v_has_ledger AND NOT v_has_sessions AND NOT v_has_events AND NOT v_has_sequence)
    OR (v_has_ledger AND v_has_sessions AND v_has_events AND v_has_sequence)
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 v2 preflight failed: ambiguous partial v1 state';
  END IF;
END $$;

SELECT current_database() AS database_name, current_user AS database_user;
COMMIT;
