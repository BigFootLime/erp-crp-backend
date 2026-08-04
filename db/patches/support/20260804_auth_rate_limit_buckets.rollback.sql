\set ON_ERROR_STOP on

-- Destructive rollback is deliberately restricted to cerp_dev/cerp_test. Production
-- rollback reverts the application release and leaves the inert table in place.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

DO $environment_guard$
BEGIN
  IF current_database() NOT IN ('cerp_dev', 'cerp_test') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback is restricted to cerp_dev/cerp_test';
  END IF;
END
$environment_guard$;

-- Match the runner's transaction-scoped serialization key before observing
-- any target state.
SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'));

-- Preserve the first observation across top-level statements. PostgreSQL READ
-- COMMITTED gives the later validation block a fresh snapshot.
SELECT
  set_config(
    'cerp.rollback_initial_table_exists',
    (observed.target_oid IS NOT NULL)::text,
    true
  ),
  set_config(
    'cerp.rollback_initial_table_oid',
    COALESCE(observed.target_oid::text, ''),
    true
  )
FROM (
  SELECT to_regclass('public.auth_rate_limit_buckets')::oid AS target_oid
) observed;

-- If the table existed at the first observation, take and retain the strongest
-- relation lock before the fresh-snapshot structural inspection below.
DO $table_lock$
BEGIN
  IF current_setting('cerp.rollback_initial_table_exists')::boolean THEN
    LOCK TABLE public.auth_rate_limit_buckets IN ACCESS EXCLUSIVE MODE;
  END IF;
END
$table_lock$;

-- A privileged concurrent DROP/recreate can retain the relation name while
-- changing its identity. Only the exact OID observed before the lock is ever
-- eligible for rollback, and the lock must be held on that OID.
DO $table_identity_guard$
DECLARE
  initial_table_exists boolean := current_setting(
    'cerp.rollback_initial_table_exists'
  )::boolean;
  initial_table_oid oid := NULLIF(
    current_setting('cerp.rollback_initial_table_oid'),
    ''
  )::oid;
  current_table_oid oid := to_regclass('public.auth_rate_limit_buckets')::oid;
BEGIN
  IF initial_table_exists AND (
    current_table_oid IS DISTINCT FROM initial_table_oid
    OR NOT EXISTS (
      SELECT 1
      FROM pg_locks
      WHERE locktype = 'relation'
        AND pid = pg_backend_pid()
        AND relation = initial_table_oid
        AND mode = 'AccessExclusiveLock'
        AND granted
    )
  ) THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: initial table identity changed before the exclusive lock; refusing rollback';
  END IF;
END
$table_identity_guard$;

-- Lock an existing provenance row in its own command. Besides preserving the
-- table-before-ledger lock order, this makes the following validation command
-- start with a fresh snapshot after any wait.
DO $registry_lock$
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    PERFORM 1
    FROM public.cerp_schema_migrations
    WHERE filename = '20260804_auth_rate_limit_buckets.sql'
    FOR UPDATE;
  END IF;
END
$registry_lock$;

DO $rollback$
DECLARE
  expected_sha256 constant text := 'f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2';
  registered_sha256 text;
  registered_applied_at timestamptz;
  initial_table_exists boolean := current_setting(
    'cerp.rollback_initial_table_exists'
  )::boolean;
  table_exists boolean;
  expiry_index_exists boolean;
  registry_exists boolean;
  registry_entry_exists boolean := FALSE;
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
  deleted_registry_rows integer;
BEGIN
  -- This is a new command snapshot after the optional table/registry locks.
  -- A table that was absent initially is never eligible for this rollback.
  table_exists := to_regclass('public.auth_rate_limit_buckets') IS NOT NULL;
  expiry_index_exists := to_regclass('public.auth_rate_limit_buckets_expires_at_idx') IS NOT NULL;
  registry_exists := to_regclass('public.cerp_schema_migrations') IS NOT NULL;

  IF registry_exists THEN
    SELECT sha256, applied_at
      INTO registered_sha256, registered_applied_at
    FROM public.cerp_schema_migrations
    WHERE filename = '20260804_auth_rate_limit_buckets.sql'
    FOR UPDATE;
    registry_entry_exists := FOUND;
  END IF;

  -- A table absent at the first observation can never enter the destructive
  -- branch. A no-op is valid only when all target artifacts are still absent.
  IF NOT initial_table_exists THEN
    IF table_exists THEN
      RAISE EXCEPTION 'SEC-CERP-0005 rollback: target table appeared concurrently before it could be locked; refusing rollback';
    END IF;
    IF registry_entry_exists OR expiry_index_exists THEN
      RAISE EXCEPTION 'SEC-CERP-0005 rollback: table is missing but its registry entry or named index remains';
    END IF;
    RETURN;
  END IF;

  IF NOT table_exists THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: initially observed table disappeared after the exclusive lock';
  END IF;

  IF NOT registry_exists THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: migration registry is missing';
  END IF;

  IF NOT registry_entry_exists THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: exact migration registry entry is missing';
  END IF;

  IF registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION
      'SEC-CERP-0005 rollback: registered checksum mismatch (expected %, found %)',
      expected_sha256,
      registered_sha256;
  END IF;

  IF registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: migration applied_at is missing';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: table kind, partitioning or row security is altered';
  END IF;

  IF table_owner_oid IS DISTINCT FROM to_regrole('cerp_app') THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: table owner is unexpected (expected cerp_app)';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO pk_definition
  FROM pg_constraint
  WHERE conrelid = 'public.auth_rate_limit_buckets'::regclass
    AND contype = 'p';

  IF pk_definition IS DISTINCT FROM 'PRIMARY KEY (scope, subject_hash)' THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: expected composite primary key is missing';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: constraints are incomplete, altered or additional';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: expected columns are incomplete or altered';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: indexes are incomplete, altered or additional';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: triggers, row policies or inheritance are additional';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: table ACL has PUBLIC, an unexpected grantee, extra privileges, grant options or missing cerp_app DML';
  END IF;

  SELECT COUNT(*)::integer
    INTO column_acl_count
  FROM pg_attribute
  WHERE attrelid = 'public.auth_rate_limit_buckets'::regclass
    AND attnum > 0
    AND NOT attisdropped
    AND attacl IS NOT NULL;

  IF column_acl_count <> 0 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: column ACLs are unexpected';
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
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: cerp_app effective table privileges are not exact DML';
  END IF;

  DROP TABLE public.auth_rate_limit_buckets;

  DELETE FROM public.cerp_schema_migrations
  WHERE filename = '20260804_auth_rate_limit_buckets.sql'
    AND sha256 = expected_sha256;

  GET DIAGNOSTICS deleted_registry_rows = ROW_COUNT;
  IF deleted_registry_rows <> 1 THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback: exact migration registry entry was not removed';
  END IF;
END
$rollback$;

COMMIT;
