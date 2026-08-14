-- Read-only SOL-28 preflight. Run after a verified encrypted backup.
DO $preflight$
DECLARE
  invalid_outbox bigint;
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-28 preflight: PostgreSQL 14 or newer is required';
  END IF;
  IF to_regclass('public.users') IS NULL OR to_regclass('public.erp_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'SOL-28 preflight: users or erp_outbox_events is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pg_function_is_visible(oid)) THEN
    RAISE EXCEPTION 'SOL-28 preflight: gen_random_uuid() is unavailable';
  END IF;
  SELECT count(*) INTO invalid_outbox
  FROM public.erp_outbox_events
  WHERE id IS NULL OR created_at IS NULL OR event_type IS NULL OR aggregate_type IS NULL OR aggregate_id IS NULL;
  IF invalid_outbox > 0 THEN
    RAISE EXCEPTION 'SOL-28 preflight: % invalid outbox row(s)', invalid_outbox;
  END IF;
END
$preflight$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_database_size(current_database()) AS database_size_bytes,
       (SELECT count(*) FROM public.users) AS user_count,
       (SELECT count(*) FROM public.erp_outbox_events) AS outbox_count,
       now() AS checked_at;
