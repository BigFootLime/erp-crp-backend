BEGIN;

-- SEC-CERP-0005: shared fixed-window counters for every backend replica.
-- `subject_hash` is an HMAC-SHA256 digest. Raw IPs, emails, usernames and reset
-- tokens must never be written to this table.
-- The runner executes this patch only while its ledger record is pending. Never
-- bless a table or index left by an interrupted/manual execution as complete.
DO $preexisting_guard$
BEGIN
  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'SEC-CERP-0005 patch: required owner/runtime role cerp_app is missing';
  END IF;

  IF to_regclass('public.auth_rate_limit_buckets') IS NOT NULL
     OR to_regclass('public.auth_rate_limit_buckets_expires_at_idx') IS NOT NULL THEN
    RAISE EXCEPTION
      'SEC-CERP-0005 patch: pre-existing rate-limit artifact found while migration is pending; reconcile it manually';
  END IF;
END
$preexisting_guard$;

CREATE TABLE public.auth_rate_limit_buckets (
  scope text NOT NULL,
  subject_hash character(64) NOT NULL,
  request_count integer NOT NULL,
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT auth_rate_limit_buckets_pk PRIMARY KEY (scope, subject_hash),
  CONSTRAINT auth_rate_limit_buckets_scope_ck
    CHECK (scope ~ '^[a-z][a-z0-9:_-]{2,63}$'),
  CONSTRAINT auth_rate_limit_buckets_subject_hash_ck
    CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_rate_limit_buckets_count_ck
    CHECK (request_count > 0),
  CONSTRAINT auth_rate_limit_buckets_window_ck
    CHECK (expires_at > window_started_at)
);

COMMENT ON TABLE public.auth_rate_limit_buckets IS
  'SEC-CERP-0005 shared auth throttling counters; HMAC pseudonyms only, no raw PII';
COMMENT ON COLUMN public.auth_rate_limit_buckets.subject_hash IS
  'HMAC-SHA256(scope and normalized subject); never a raw IP, email, username or token';

CREATE INDEX auth_rate_limit_buckets_expires_at_idx
  ON public.auth_rate_limit_buckets (expires_at);

-- The real cerp_test/cerp_prod contract owns public application tables with
-- cerp_app. Reset the ACL after ownership transfer so creator default ACLs
-- cannot leak privileges to PUBLIC or another role.
ALTER TABLE public.auth_rate_limit_buckets OWNER TO cerp_app;
REVOKE ALL ON public.auth_rate_limit_buckets FROM PUBLIC;

DO $acl_contract$
DECLARE
  unexpected_grantee name;
  total_acl_entries integer;
  expected_acl_entries integer;
  effective_privileges_are_expected boolean;
BEGIN
  FOR unexpected_grantee IN
    SELECT DISTINCT grantee_role.rolname
    FROM pg_class relation_metadata
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation_metadata.relacl,
        acldefault('r', relation_metadata.relowner)
      )
    ) acl_entry
    JOIN pg_roles grantee_role ON grantee_role.oid = acl_entry.grantee
    WHERE relation_metadata.oid = 'public.auth_rate_limit_buckets'::regclass
      AND acl_entry.grantee <> relation_metadata.relowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON public.auth_rate_limit_buckets FROM %I CASCADE',
      unexpected_grantee
    );
  END LOOP;

  -- Ownership has unavoidable object-control and regrant authority. Ordinary
  -- table privileges are nevertheless reduced to the four runtime DML rights,
  -- without grant option, and contain no other grantee.
  REVOKE ALL ON public.auth_rate_limit_buckets FROM cerp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_rate_limit_buckets TO cerp_app;

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

  SELECT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'SELECT')
         AND has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'INSERT')
         AND has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'UPDATE')
         AND has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'DELETE')
         AND NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'TRUNCATE')
         AND NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'REFERENCES')
         AND NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'TRIGGER')
    INTO effective_privileges_are_expected;

  IF total_acl_entries <> 4
     OR expected_acl_entries <> 4
     OR effective_privileges_are_expected IS NOT TRUE THEN
    RAISE EXCEPTION 'SEC-CERP-0005 patch: exact cerp_app ACL contract was not established';
  END IF;
END
$acl_contract$;

COMMIT;
