BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.password_resets') IS NULL
     OR to_regclass('public.password_reset_tokens') IS NULL OR to_regclass('public.user_mfa_recovery_codes') IS NULL
     OR to_regclass('public.auth_mfa_challenges') IS NULL OR to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.cerp_terminal_pins') IS NULL OR to_regclass('public.cerp_terminal_audit') IS NULL
     OR to_regclass('public.operator_badge_credentials') IS NULL OR to_regclass('public.operator_device_sessions') IS NULL THEN
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
  CHECK (completed_at IS NULL OR superseded_at IS NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_account_recoveries_one_pending_uq
  ON public.admin_account_recoveries(user_id) WHERE superseded_at IS NULL AND completed_at IS NULL;

CREATE OR REPLACE FUNCTION public.cerp_guard_account_recovery_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Account recovery evidence cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.actor_user_id,NEW.idempotency_key,NEW.request_hash,NEW.reason,
         NEW.reset_id,NEW.token_hash,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.actor_user_id,OLD.idempotency_key,OLD.request_hash,OLD.reason,
         OLD.reset_id,OLD.token_hash,OLD.created_at,OLD.expires_at)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Account recovery evidence is immutable; only forward completion is allowed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admin_account_recoveries_evidence_guard ON public.admin_account_recoveries;
CREATE TRIGGER admin_account_recoveries_evidence_guard BEFORE UPDATE OR DELETE
  ON public.admin_account_recoveries FOR EACH ROW EXECUTE FUNCTION public.cerp_guard_account_recovery_evidence();

-- Reset rows may expire and be cleaned up. The durable recovery and audit
-- evidence remains; reset_id deliberately does not cascade with that cleanup.
GRANT SELECT, INSERT, UPDATE ON public.admin_account_recoveries TO cerp_app;
REVOKE DELETE, TRUNCATE ON public.admin_account_recoveries FROM cerp_app;
COMMIT;
