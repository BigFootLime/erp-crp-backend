-- Read-only SOL-32 preflight. Run only after a verified backup.
DO $preflight$
DECLARE
  privileged_without_email bigint;
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-32 preflight: PostgreSQL 14 or newer is required';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'SOL-32 preflight: users, realtime_session_epochs and erp_audit_logs are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pg_function_is_visible(oid)) THEN
    RAISE EXCEPTION 'SOL-32 preflight: gen_random_uuid() is unavailable';
  END IF;
  SELECT count(*) INTO privileged_without_email
    FROM public.users
   WHERE is_superadmin IS TRUE AND status = 'Active' AND NULLIF(btrim(email), '') IS NULL;
  IF privileged_without_email > 0 THEN
    RAISE NOTICE 'SOL-32: % active privileged account(s) lack email; recovery remains out-of-band only', privileged_without_email;
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_database_size(current_database()) AS database_size_bytes,
       count(*) FILTER (WHERE is_superadmin IS TRUE AND status = 'Active') AS active_privileged_accounts,
       now() AS checked_at
FROM public.users;
