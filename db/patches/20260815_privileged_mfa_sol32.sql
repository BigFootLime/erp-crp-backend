-- SOL-32 — privileged-account TOTP MFA.
-- Additive, idempotent and safe to replay. Secrets are encrypted by the
-- application; recovery codes and challenge tokens are stored as keyed or
-- one-way hashes only.

BEGIN;

DO $preconditions$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-32 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'SOL-32 prerequisite relation is missing';
  END IF;
END
$preconditions$;

CREATE TABLE IF NOT EXISTS public.user_mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  factor_type text NOT NULL DEFAULT 'TOTP',
  state text NOT NULL DEFAULT 'PENDING',
  encrypted_secret bytea NOT NULL,
  encryption_iv bytea NOT NULL,
  encryption_tag bytea NOT NULL,
  key_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_verified_step bigint NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz NULL,
  pending_expires_at timestamptz NULL,
  enrolled_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_factor_type_ck CHECK (factor_type = 'TOTP'),
  CONSTRAINT user_mfa_factor_state_ck CHECK (state IN ('PENDING','ACTIVE','REVOKED')),
  CONSTRAINT user_mfa_factor_crypto_ck CHECK (
    octet_length(encrypted_secret) BETWEEN 16 AND 256
    AND octet_length(encryption_iv) = 12
    AND octet_length(encryption_tag) = 16
    AND char_length(key_id) BETWEEN 1 AND 80
  ),
  CONSTRAINT user_mfa_factor_counters_ck CHECK (version > 0 AND failed_attempts >= 0),
  CONSTRAINT user_mfa_factor_lifecycle_ck CHECK (
    (state = 'PENDING' AND pending_expires_at IS NOT NULL AND enrolled_at IS NULL AND revoked_at IS NULL)
    OR (state = 'ACTIVE' AND pending_expires_at IS NULL AND enrolled_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_mfa_factors_one_active_uq
  ON public.user_mfa_factors(user_id) WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS user_mfa_factors_one_pending_uq
  ON public.user_mfa_factors(user_id) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS user_mfa_factors_user_history_idx
  ON public.user_mfa_factors(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.user_mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES public.user_mfa_factors(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  code_hash text NOT NULL,
  used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_recovery_hash_ck CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_mfa_recovery_uq UNIQUE (factor_id, code_hash)
);

CREATE INDEX IF NOT EXISTS user_mfa_recovery_available_idx
  ON public.user_mfa_recovery_codes(factor_id, created_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS public.auth_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  factor_id uuid NOT NULL REFERENCES public.user_mfa_factors(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  session_epoch integer NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_mfa_challenge_purpose_ck CHECK (purpose IN ('LOGIN','ENROLL','REPLACE')),
  CONSTRAINT auth_mfa_challenge_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_mfa_challenge_counters_ck CHECK (session_epoch >= 0 AND attempt_count >= 0),
  CONSTRAINT auth_mfa_challenge_expiry_ck CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS auth_mfa_challenges_user_active_idx
  ON public.auth_mfa_challenges(user_id, purpose, expires_at DESC)
  WHERE used_at IS NULL;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.user_mfa_factors TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_mfa_recovery_codes TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_mfa_challenges TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
