-- SOL-02 production drift repair.
-- Recreates the final account-provisioning tables when an older ledger claims
-- password-reset support was applied but the runtime table is absent.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.realtime_authorization_epoch') IS NULL THEN
    RAISE EXCEPTION 'SOL-02 repair: required account and realtime tables are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-02 repair: required cerp_app role is missing';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  used_at TIMESTAMP WITHOUT TIME ZONE NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  created_by INTEGER NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NULL,
  request_hash CHAR(64) NULL
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.password_reset_tokens
  ADD COLUMN IF NOT EXISTS created_by INTEGER NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key UUID NULL,
  ADD COLUMN IF NOT EXISTS request_hash CHAR(64) NULL
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
  ON public.password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx
  ON public.password_reset_tokens (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_user_hash_uq
  ON public.password_reset_tokens (user_id, token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_actor_idempotency_uq
  ON public.password_reset_tokens (created_by, idempotency_key)
  WHERE created_by IS NOT NULL AND idempotency_key IS NOT NULL;

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

ALTER TABLE public.password_reset_tokens OWNER TO cerp_app;
ALTER TABLE public.admin_account_invitations OWNER TO cerp_app;

REVOKE ALL ON TABLE public.password_reset_tokens FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_account_invitations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.password_reset_tokens TO cerp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_account_invitations TO cerp_app;

COMMENT ON TABLE public.password_reset_tokens IS
  'Single-use password reset tokens. Token material is stored only as a hash.';
COMMENT ON TABLE public.admin_account_invitations IS
  'Idempotent administrative invitations. Only a signed, unexpired token can activate its inactive account.';
COMMENT ON COLUMN public.password_reset_tokens.idempotency_key IS
  'Administrative reset creation retry key; NULL for legacy or public-reset tokens.';

COMMIT;
