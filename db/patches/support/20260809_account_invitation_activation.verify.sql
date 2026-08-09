-- Read-only verification for SOL-02 / SEC-CERP-0002. Every boolean must be true.

SELECT
  to_regclass('public.admin_account_invitations') IS NOT NULL AS has_invitation_table,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.admin_account_invitations'::regclass
      AND contype = 'p'
  ) AS has_primary_key,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.admin_account_invitations'::regclass
      AND conname = 'admin_account_invitations_actor_idempotency_uq'
  ) AS has_actor_idempotency,
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'admin_account_invitations'
      AND indexname = 'admin_account_invitations_one_open_per_user_uq'
  ) AS has_single_open_invitation_guard,
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'password_reset_tokens'
      AND indexname = 'password_reset_tokens_actor_idempotency_uq'
  ) AS has_admin_reset_idempotency,
  NOT EXISTS (
    SELECT 1
    FROM public.password_reset_tokens
    WHERE created_by IS NOT NULL
      AND (idempotency_key IS NULL OR request_hash !~ '^[0-9a-f]{64}$')
  ) AS admin_reset_rows_are_valid,
  NOT EXISTS (
    SELECT 1
    FROM public.admin_account_invitations
    WHERE request_hash !~ '^[0-9a-f]{64}$'
       OR token_hash !~ '^[0-9a-f]{64}$'
       OR expires_at <= created_at
       OR (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)
  ) AS invitation_rows_are_valid;
