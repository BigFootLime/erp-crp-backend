-- SOL-02 / SEC-CERP-0002
-- One-use, auditable account invitations for inactive administrative accounts.
-- Apply to cerp_test and verify before any production decision.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_account_invitations (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_by INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  token_hash CHAR(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  CONSTRAINT admin_account_invitations_actor_idempotency_uq
    UNIQUE (created_by, idempotency_key),
  CONSTRAINT admin_account_invitations_timeline_ck CHECK (
    expires_at > created_at
    AND (accepted_at IS NULL OR accepted_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
    AND NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_account_invitations_token_hash_uq
  ON public.admin_account_invitations (token_hash);

CREATE INDEX IF NOT EXISTS admin_account_invitations_user_created_idx
  ON public.admin_account_invitations (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS admin_account_invitations_one_open_per_user_uq
  ON public.admin_account_invitations (user_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE public.admin_account_invitations IS
  'Idempotent administrative invitations. Only a signed, unexpired token can activate its inactive account.';

ALTER TABLE public.password_reset_tokens
  ADD COLUMN IF NOT EXISTS created_by INTEGER NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key UUID NULL,
  ADD COLUMN IF NOT EXISTS request_hash CHAR(64) NULL
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_actor_idempotency_uq
  ON public.password_reset_tokens (created_by, idempotency_key)
  WHERE created_by IS NOT NULL AND idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.password_reset_tokens.idempotency_key IS
  'Administrative reset creation retry key; NULL for legacy or public-reset tokens.';

COMMIT;
