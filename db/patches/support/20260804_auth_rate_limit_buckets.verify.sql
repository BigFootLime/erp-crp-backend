\set ON_ERROR_STOP on

-- Read-only structural verification. Counter behavior is covered by the
-- deterministic application tests; this script never inserts identifying data.
DO $verify$
DECLARE
  table_metadata_is_expected boolean;
  table_owner_oid oid;
  pk_definition text;
  total_constraint_count integer;
  required_constraint_count integer;
  total_column_count integer;
  expected_column_count integer;
  total_index_count integer;
  expiry_index_is_expected boolean;
  user_trigger_count integer;
  policy_count integer;
  inheritance_parent_count integer;
  total_acl_entries integer;
  expected_acl_entries integer;
  column_acl_count integer;
  owner_effective_privileges_are_expected boolean;
  registered_sha256 text;
  registered_applied_at timestamptz;
  expected_sha256 constant text := 'f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2';
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: unexpected database %', current_database();
  END IF;

  IF to_regclass('public.auth_rate_limit_buckets') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: table is missing';
  END IF;

  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: migration registry is missing';
  END IF;

  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: role cerp_app is missing';
  END IF;

  SELECT sha256, applied_at
    INTO registered_sha256, registered_applied_at
  FROM public.cerp_schema_migrations
  WHERE filename = '20260804_auth_rate_limit_buckets.sql';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: migration registry entry is missing';
  END IF;

  IF registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION
      'SEC-CERP-0005 verify: registered checksum mismatch (expected %, found %)',
      expected_sha256,
      registered_sha256;
  END IF;

  IF registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: migration applied_at is missing';
  END IF;

  SELECT relkind = 'r'
         AND NOT relispartition
         AND NOT relrowsecurity
         AND NOT relforcerowsecurity,
         relowner
    INTO table_metadata_is_expected, table_owner_oid
  FROM pg_class
  WHERE oid = 'public.auth_rate_limit_buckets'::regclass;

  IF table_metadata_is_expected IS NOT TRUE THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: table kind, partitioning or row security is altered';
  END IF;

  IF table_owner_oid IS DISTINCT FROM to_regrole('cerp_app') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: table owner is unexpected (expected cerp_app)';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO pk_definition
  FROM pg_constraint
  WHERE conrelid = 'public.auth_rate_limit_buckets'::regclass
    AND contype = 'p';

  IF pk_definition IS DISTINCT FROM 'PRIMARY KEY (scope, subject_hash)' THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: expected composite primary key is missing';
  END IF;

  SELECT COUNT(*)::integer
    INTO total_constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.auth_rate_limit_buckets'::regclass;

  SELECT COUNT(*)::integer
    INTO required_constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.auth_rate_limit_buckets'::regclass
    AND contype = 'c'
    AND convalidated
    AND conname = ANY (ARRAY[
      'auth_rate_limit_buckets_scope_ck',
      'auth_rate_limit_buckets_subject_hash_ck',
      'auth_rate_limit_buckets_count_ck',
      'auth_rate_limit_buckets_window_ck'
    ])
    AND pg_get_constraintdef(oid) = CASE conname
      WHEN 'auth_rate_limit_buckets_scope_ck'
        THEN 'CHECK ((scope ~ ''^[a-z][a-z0-9:_-]{2,63}$''::text))'
      WHEN 'auth_rate_limit_buckets_subject_hash_ck'
        THEN 'CHECK ((subject_hash ~ ''^[0-9a-f]{64}$''::text))'
      WHEN 'auth_rate_limit_buckets_count_ck'
        THEN 'CHECK ((request_count > 0))'
      WHEN 'auth_rate_limit_buckets_window_ck'
        THEN 'CHECK ((expires_at > window_started_at))'
    END;

  IF total_constraint_count <> 5 OR required_constraint_count <> 4 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: constraints are incomplete, altered or additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE
           (column_name = 'scope'
             AND data_type = 'text'
             AND is_nullable = 'NO'
             AND column_default IS NULL)
           OR (column_name = 'subject_hash'
             AND data_type = 'character'
             AND character_maximum_length = 64
             AND is_nullable = 'NO'
             AND column_default IS NULL)
           OR (column_name = 'request_count'
             AND data_type = 'integer'
             AND is_nullable = 'NO'
             AND column_default IS NULL)
           OR (column_name IN ('window_started_at', 'expires_at')
             AND data_type = 'timestamp with time zone'
             AND is_nullable = 'NO'
             AND column_default IS NULL)
           OR (column_name = 'updated_at'
             AND data_type = 'timestamp with time zone'
             AND is_nullable = 'NO'
             AND column_default = 'statement_timestamp()')
         )::integer
    INTO total_column_count, expected_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'auth_rate_limit_buckets';

  IF total_column_count <> 6 OR expected_column_count <> 6 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: columns, types, nullability or defaults are altered';
  END IF;

  SELECT COUNT(*)::integer
    INTO total_index_count
  FROM pg_index
  WHERE indrelid = 'public.auth_rate_limit_buckets'::regclass;

  SELECT EXISTS (
    SELECT 1
    FROM pg_index index_metadata
    JOIN pg_class index_class ON index_class.oid = index_metadata.indexrelid
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    WHERE index_metadata.indrelid = 'public.auth_rate_limit_buckets'::regclass
      AND index_metadata.indexrelid = to_regclass('public.auth_rate_limit_buckets_expires_at_idx')
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisunique
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND access_method.amname = 'btree'
      AND pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = 'expires_at'
  ) INTO expiry_index_is_expected;

  IF total_index_count <> 2 OR NOT expiry_index_is_expected THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: indexes are incomplete, altered or additional';
  END IF;

  SELECT COUNT(*)::integer
    INTO user_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'public.auth_rate_limit_buckets'::regclass
    AND NOT tgisinternal;

  SELECT COUNT(*)::integer
    INTO policy_count
  FROM pg_policy
  WHERE polrelid = 'public.auth_rate_limit_buckets'::regclass;

  SELECT COUNT(*)::integer
    INTO inheritance_parent_count
  FROM pg_inherits
  WHERE inhrelid = 'public.auth_rate_limit_buckets'::regclass;

  IF user_trigger_count <> 0 OR policy_count <> 0 OR inheritance_parent_count <> 0 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: triggers, row policies or inheritance are additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE
           acl_entry.grantor = to_regrole('cerp_app')
           AND acl_entry.grantee = to_regrole('cerp_app')
           AND acl_entry.privilege_type = ANY (
             ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
           )
           AND NOT acl_entry.is_grantable
         )::integer
    INTO total_acl_entries, expected_acl_entries
  FROM pg_class relation_metadata
  CROSS JOIN LATERAL aclexplode(
    COALESCE(
      relation_metadata.relacl,
      acldefault('r', relation_metadata.relowner)
    )
  ) acl_entry
  WHERE relation_metadata.oid = 'public.auth_rate_limit_buckets'::regclass;

  IF total_acl_entries <> 4 OR expected_acl_entries <> 4 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: table ACL has PUBLIC, an unexpected grantee, extra privileges, grant options or missing cerp_app DML';
  END IF;

  SELECT COUNT(*)::integer
    INTO column_acl_count
  FROM pg_attribute
  WHERE attrelid = 'public.auth_rate_limit_buckets'::regclass
    AND attnum > 0
    AND NOT attisdropped
    AND attacl IS NOT NULL;

  IF column_acl_count <> 0 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: column ACLs are unexpected';
  END IF;

  SELECT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'SELECT')
         AND has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'INSERT')
         AND has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'UPDATE')
         AND has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'DELETE')
         AND NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'TRUNCATE')
         AND NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'REFERENCES')
         AND NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'TRIGGER')
    INTO owner_effective_privileges_are_expected;

  IF owner_effective_privileges_are_expected IS NOT TRUE THEN
    RAISE EXCEPTION 'SEC-CERP-0005 verify: cerp_app effective table privileges are not exact DML';
  END IF;
END
$verify$;

SELECT
  current_database() AS database_name,
  (
    SELECT sha256
    FROM public.cerp_schema_migrations
    WHERE filename = '20260804_auth_rate_limit_buckets.sql'
  ) AS migration_sha256,
  (
    SELECT applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260804_auth_rate_limit_buckets.sql'
  ) AS migration_applied_at,
  COUNT(*) AS current_pseudonymous_buckets,
  MIN(expires_at) AS oldest_expiry,
  MAX(expires_at) AS newest_expiry,
  'SEC-CERP-0005 verification passed (read-only)' AS result
FROM public.auth_rate_limit_buckets;
