\set ON_ERROR_STOP on

DO $preflight$
DECLARE invalid_policy text;
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'PostgreSQL 14 or newer is required';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.erp_settings') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'Required SOL-32/SOL-06 relations are missing';
  END IF;
  SELECT value_text INTO invalid_policy
    FROM public.erp_settings
   WHERE key='security.mfa_policy'
     AND value_text NOT IN ('disabled','optional','required_for_admins','required_for_all');
  IF invalid_policy IS NOT NULL THEN
    RAISE EXCEPTION 'Existing security.mfa_policy is invalid: %', invalid_policy;
  END IF;
END
$preflight$;

SELECT
  current_database() AS database_name,
  current_setting('server_version') AS postgres_version,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  (SELECT count(*) FROM public.users) AS user_count,
  (SELECT count(*) FROM public.user_mfa_factors WHERE state='ACTIVE') AS active_factor_count,
  (SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy') AS current_policy;
