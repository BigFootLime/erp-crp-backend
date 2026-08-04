\set ON_ERROR_STOP on

-- SEC-CERP-0004 preflight: read-only prerequisite and collision checks.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.user_role_assignments') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0004 preflight failed: users or user_role_assignments is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pg_function_is_visible(oid)
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0004 preflight failed: gen_random_uuid() is unavailable';
  END IF;
END $$;

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'users' AND column_name IN ('id', 'password', 'role', 'status'))
    OR (table_name = 'user_role_assignments' AND column_name IN ('user_id', 'role_key'))
  )
ORDER BY table_name, column_name;

SELECT
  to_regclass('public.realtime_session_epochs') AS existing_session_registry,
  to_regclass('public.realtime_event_log') AS existing_event_log;

COMMIT;
