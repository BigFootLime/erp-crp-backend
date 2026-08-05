\set ON_ERROR_STOP on
\echo '=== GPT56-FEAT-CERP-0004 preflight (read-only) ==='

SELECT current_database() AS database_name, current_user AS database_user,
       current_setting('server_version') AS postgres_version;

DO $preflight$
BEGIN
  IF to_regclass('public.programmations') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.machines') IS NULL
     OR to_regclass('public.postes') IS NULL
     OR to_regclass('public.of_operations') IS NULL
     OR to_regclass('public.app_notifications') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regprocedure('public.tg_set_updated_at()') IS NULL
     OR to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 preflight: prerequisite object missing';
  END IF;
  IF to_regclass('public.programmation_reschedule_operations') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'programmations'
         AND column_name = 'version'
     ) THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004 preflight: target artifacts already exist';
  END IF;
END
$preflight$;

SELECT COUNT(*) AS existing_programmations,
       MIN(date_commencement) AS earliest_date,
       MAX(date_fin) AS latest_date,
       COUNT(*) FILTER (WHERE archived_at IS NULL) AS active_programmations
FROM public.programmations;

SELECT programmer_user_id, date_commencement, date_fin, COUNT(*) AS overlapping_rows
FROM public.programmations
WHERE archived_at IS NULL AND programmer_user_id IS NOT NULL
GROUP BY programmer_user_id, date_commencement, date_fin
HAVING COUNT(*) > 1
ORDER BY overlapping_rows DESC, programmer_user_id
LIMIT 25;
