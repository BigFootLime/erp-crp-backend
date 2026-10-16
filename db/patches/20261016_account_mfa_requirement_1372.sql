-- Additive account-level MFA requirement. Directory provisioning uses the same
-- column in its isolated authority schema; site projections never own passwords.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $prerequisites$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'Account MFA requirement prerequisites are missing';
  END IF;
END
$prerequisites$;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;

DO $column_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass
      AND attname = 'mfa_required'
      AND atttypid = 'boolean'::regtype AND attnotnull AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'users.mfa_required must be a non-null boolean';
  END IF;
END
$column_contract$;

UPDATE public.users SET mfa_required = true WHERE is_superadmin AND NOT mfa_required;
GRANT SELECT(mfa_required), INSERT(mfa_required), UPDATE(mfa_required)
  ON public.users TO cerp_app;

COMMENT ON COLUMN public.users.mfa_required IS
  'Durable account MFA requirement; independent of descriptive job roles and global optional policy';
COMMIT;
