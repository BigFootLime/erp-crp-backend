\set ON_ERROR_STOP on

-- Read-only structural verification. Counter behavior is covered by the
-- deterministic application tests; this script never inserts identifying data.
DO $verify$
DECLARE
  pk_definition text;
  required_constraint_count integer;
  hash_length integer;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: unexpected database %', current_database();
  END IF;

  IF to_regclass('public.auth_rate_limit_buckets') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: table is missing';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO pk_definition
  FROM pg_constraint
  WHERE conrelid = 'public.auth_rate_limit_buckets'::regclass
    AND contype = 'p';

  IF pk_definition IS NULL OR pk_definition NOT LIKE '%(scope, subject_hash)%' THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: expected composite primary key is missing';
  END IF;

  SELECT COUNT(*)::integer
    INTO required_constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.auth_rate_limit_buckets'::regclass
    AND convalidated
    AND conname = ANY (ARRAY[
      'auth_rate_limit_buckets_scope_ck',
      'auth_rate_limit_buckets_subject_hash_ck',
      'auth_rate_limit_buckets_count_ck',
      'auth_rate_limit_buckets_window_ck'
    ]);

  IF required_constraint_count <> 4 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: required validated checks are incomplete';
  END IF;

  SELECT character_maximum_length
    INTO hash_length
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'auth_rate_limit_buckets'
    AND column_name = 'subject_hash';

  IF hash_length IS DISTINCT FROM 64 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: subject_hash must be character(64)';
  END IF;

  IF to_regclass('public.auth_rate_limit_buckets_expires_at_idx') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: expiry index is missing';
  END IF;

  IF has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'SELECT') IS NOT TRUE
     OR has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'INSERT') IS NOT TRUE
     OR has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'UPDATE') IS NOT TRUE
     OR has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'DELETE') IS NOT TRUE THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: cerp_app privileges are incomplete';
  END IF;
END
$verify$;

SELECT
  current_database() AS database_name,
  COUNT(*) AS current_pseudonymous_buckets,
  MIN(expires_at) AS oldest_expiry,
  MAX(expires_at) AS newest_expiry,
  'SEC-CERP-0005 verification passed (read-only)' AS result
FROM public.auth_rate_limit_buckets;
