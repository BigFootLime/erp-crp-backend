\set ON_ERROR_STOP on

-- SEC-CERP-0004 verification: catalog/privilege checks only.
BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.realtime_event_log') IS NULL
     OR to_regclass('public.realtime_event_log_sequence_seq') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 verify failed: shared control-plane relations are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'users_realtime_session_update_trg' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'users_realtime_session_delete_trg' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'user_role_assignments_realtime_session_trg' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 verify failed: session-revocation trigger is missing';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
     AND (
       NOT has_table_privilege('cerp_app', 'public.realtime_session_epochs', 'SELECT,INSERT,UPDATE')
       OR NOT has_table_privilege('cerp_app', 'public.realtime_event_log', 'SELECT,INSERT,UPDATE,DELETE')
       OR NOT has_sequence_privilege('cerp_app', 'public.realtime_event_log_sequence_seq', 'USAGE,SELECT')
     ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 verify failed: cerp_app runtime grants are incomplete';
  END IF;
END $$;

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('realtime_session_epochs', 'realtime_event_log')
ORDER BY table_name, ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('realtime_session_epochs', 'realtime_event_log')
ORDER BY indexname;

SELECT tgname, pg_get_triggerdef(oid) AS trigger_definition
FROM pg_trigger
WHERE tgname IN (
  'users_realtime_session_update_trg',
  'users_realtime_session_delete_trg',
  'user_role_assignments_realtime_session_trg'
)
  AND NOT tgisinternal
ORDER BY tgname;

COMMIT;
