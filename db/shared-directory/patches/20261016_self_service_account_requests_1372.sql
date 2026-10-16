BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$' THEN
    RAISE EXCEPTION 'Account-request authority patch refused outside a shared-directory database';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.cerp_directory_profiles') IS NULL
     OR to_regclass('public.cerp_directory_memberships') IS NULL THEN
    RAISE EXCEPTION 'Account-request directory prerequisites are missing';
  END IF;
END $$;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;
UPDATE public.users SET mfa_required = true WHERE is_superadmin AND NOT mfa_required;

CREATE TABLE IF NOT EXISTS public.cerp_directory_account_requests (
  id uuid PRIMARY KEY,
  receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING','PROJECTION_PENDING','APPROVED','REJECTED','EXPIRED')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  surname text NOT NULL CHECK (length(btrim(surname)) BETWEEN 2 AND 80),
  email text NOT NULL CHECK (length(btrim(email)) BETWEEN 3 AND 320),
  password_hash text NULL,
  avatar_key text NOT NULL,
  username_base text NOT NULL CHECK (username_base ~ '^[A-Z0-9._-]+$'),
  approved_username text NULL CHECK (approved_username IS NULL OR approved_username ~ '^[A-Z0-9._-]+$'),
  profile_id uuid NULL UNIQUE REFERENCES public.cerp_directory_profiles(profile_id) ON DELETE RESTRICT,
  primary_role text NULL,
  roles text[] NULL,
  administrative_kind text NULL CHECK (administrative_kind IS NULL OR administrative_kind IN ('STANDARD','BUSINESS_ADMIN')),
  module_keys text[] NULL,
  reviewed_by_profile_id uuid NULL REFERENCES public.cerp_directory_profiles(profile_id) ON DELETE RESTRICT,
  reviewed_at timestamptz NULL,
  redacted_at timestamptz NULL,
  rejection_reason text NULL CHECK (rejection_reason IS NULL OR length(btrim(rejection_reason)) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  CHECK (expires_at > created_at),
  CHECK ((status = 'PENDING') = (reviewed_at IS NULL)),
  CHECK ((status IN ('PROJECTION_PENDING','APPROVED')) = (profile_id IS NOT NULL AND approved_username IS NOT NULL AND primary_role IS NOT NULL AND roles IS NOT NULL AND administrative_kind IS NOT NULL AND module_keys IS NOT NULL)),
  CHECK (status NOT IN ('PENDING','REJECTED','EXPIRED') OR profile_id IS NULL),
  CHECK (status NOT IN ('PROJECTION_PENDING','APPROVED') OR password_hash IS NULL)
);
CREATE INDEX IF NOT EXISTS cerp_directory_account_requests_pending_created_idx
  ON public.cerp_directory_account_requests(status, created_at, id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS public.cerp_directory_account_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.cerp_directory_account_requests(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('SUBMITTED','APPROVAL_PREPARED','ACTIVATED','REJECTED','EXPIRED','REDACTED')),
  actor_profile_id uuid NULL REFERENCES public.cerp_directory_profiles(profile_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS cerp_directory_account_request_events_request_idx
  ON public.cerp_directory_account_request_events(request_id, occurred_at, id);
CREATE TABLE IF NOT EXISTS public.cerp_directory_account_request_mutations (
  request_id uuid NOT NULL REFERENCES public.cerp_directory_account_requests(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('APPROVE','REJECT','DELETE')),
  idempotency_key uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, operation, idempotency_key)
);
CREATE OR REPLACE FUNCTION public.cerp_guard_directory_account_request_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'directory account request events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS cerp_directory_account_request_events_append_only ON public.cerp_directory_account_request_events;
CREATE TRIGGER cerp_directory_account_request_events_append_only
  BEFORE UPDATE OR DELETE ON public.cerp_directory_account_request_events
  FOR EACH ROW EXECUTE FUNCTION public.cerp_guard_directory_account_request_events_append_only();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_directory_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.cerp_directory_account_requests TO cerp_directory_app;
    GRANT SELECT, INSERT ON public.cerp_directory_account_request_events TO cerp_directory_app;
    GRANT SELECT, INSERT ON public.cerp_directory_account_request_mutations TO cerp_directory_app;
    GRANT SELECT(mfa_required), INSERT(mfa_required), UPDATE(mfa_required) ON public.users TO cerp_directory_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    REVOKE ALL ON public.cerp_directory_account_requests, public.cerp_directory_account_request_events, public.cerp_directory_account_request_mutations FROM cerp_app;
  END IF;
END
$grants$;
COMMIT;
