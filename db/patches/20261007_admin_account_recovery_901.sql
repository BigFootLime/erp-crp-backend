BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.password_resets') IS NULL
     OR to_regclass('public.password_reset_tokens') IS NULL OR to_regclass('public.user_mfa_recovery_codes') IS NULL
     OR to_regclass('public.auth_mfa_challenges') IS NULL OR to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL THEN
    RAISE EXCEPTION 'Account recovery requires the canonical account, password reset and MFA schemas';
  END IF;
END $$;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mfa_reenrollment_required boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.admin_account_recoveries (
  id uuid PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 20 AND 500),
  reset_id uuid NOT NULL UNIQUE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  superseded_at timestamptz,
  completed_at timestamptz,
  CHECK (user_id <> actor_user_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_account_recoveries_one_pending_uq
  ON public.admin_account_recoveries(user_id) WHERE superseded_at IS NULL AND completed_at IS NULL;

-- Reset rows may expire and be cleaned up. The durable recovery and audit
-- evidence remains; reset_id deliberately does not cascade with that cleanup.
GRANT SELECT, INSERT, UPDATE ON public.admin_account_recoveries TO cerp_app;
COMMIT;
