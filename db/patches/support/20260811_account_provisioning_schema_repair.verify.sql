-- Read-only verification for the SOL-02 schema-drift repair. Every boolean must be true.

SELECT
  to_regclass('public.password_reset_tokens') IS NOT NULL AS password_reset_tokens_present,
  to_regclass('public.admin_account_invitations') IS NOT NULL AS invitations_present,
  (SELECT tableowner = 'cerp_app' FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'password_reset_tokens') AS reset_owner_is_cerp_app,
  (SELECT tableowner = 'cerp_app' FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'admin_account_invitations') AS invitation_owner_is_cerp_app,
  has_table_privilege('cerp_app', 'public.password_reset_tokens', 'SELECT,INSERT,UPDATE,DELETE')
    AS reset_runtime_privileges,
  has_table_privilege('cerp_app', 'public.admin_account_invitations', 'SELECT,INSERT,UPDATE,DELETE')
    AS invitation_runtime_privileges,
  NOT EXISTS (
    SELECT 1
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(relation.relacl, acldefault('r', relation.relowner))
    ) privilege
    WHERE relation.oid = 'public.password_reset_tokens'::regclass
      AND privilege.grantee = 0
      AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) AS reset_not_public,
  NOT EXISTS (
    SELECT 1
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(relation.relacl, acldefault('r', relation.relowner))
    ) privilege
    WHERE relation.oid = 'public.admin_account_invitations'::regclass
      AND privilege.grantee = 0
      AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) AS invitation_not_public,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'password_reset_tokens'
      AND indexname = 'password_reset_tokens_actor_idempotency_uq'
  ) AS reset_idempotency_guard,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'admin_account_invitations'
      AND indexname = 'admin_account_invitations_one_open_per_user_uq'
  ) AS invitation_single_open_guard;
