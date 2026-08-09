-- GPT56-CERP-0001-A / SEC-CERP-0001
-- Administrative-only, idempotent user provisioning with optional HR attributes.
-- Additive and safe for existing accounts. Apply to cerp_test before any production decision.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_user_provisioning_migration_state (
  column_name TEXT PRIMARY KEY,
  was_not_null BOOLEAN NOT NULL
);

INSERT INTO public.admin_user_provisioning_migration_state (column_name, was_not_null)
SELECT column_name, is_nullable = 'NO'
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
  AND column_name = ANY (ARRAY[
    'tel_no', 'gender', 'address', 'lane', 'house_no', 'postcode',
    'salary', 'date_of_birth', 'employment_date', 'employment_end_date',
    'national_id', 'social_security_number'
  ])
ON CONFLICT (column_name) DO NOTHING;

ALTER TABLE public.users
  ALTER COLUMN tel_no DROP NOT NULL,
  ALTER COLUMN gender DROP NOT NULL,
  ALTER COLUMN address DROP NOT NULL,
  ALTER COLUMN lane DROP NOT NULL,
  ALTER COLUMN house_no DROP NOT NULL,
  ALTER COLUMN postcode DROP NOT NULL,
  ALTER COLUMN salary DROP NOT NULL,
  ALTER COLUMN date_of_birth DROP NOT NULL,
  ALTER COLUMN employment_date DROP NOT NULL,
  ALTER COLUMN employment_end_date DROP NOT NULL,
  ALTER COLUMN national_id DROP NOT NULL,
  ALTER COLUMN social_security_number DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.admin_user_provisioning_requests (
  idempotency_key UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  user_id INTEGER NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_admin_user_provisioning_requests_expires_at
  ON public.admin_user_provisioning_requests (expires_at);

COMMENT ON TABLE public.admin_user_provisioning_requests IS
  'Short-lived idempotency records for authenticated administrative account provisioning.';

COMMIT;
