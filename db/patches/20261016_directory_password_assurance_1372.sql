-- Preserve MFA projections; permit an explicit absence of assurance for an
-- ordinary account whose live canonical policy permits password-only login.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF to_regclass('public.cerp_directory_projection_state') IS NULL THEN
    RAISE EXCEPTION 'Shared directory projection prerequisite is missing';
  END IF;
END $$;
ALTER TABLE public.cerp_directory_projection_state
  ALTER COLUMN mfa_factor_id DROP NOT NULL,
  ALTER COLUMN mfa_factor_version DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_directory_projection_state'::regclass AND conname='cerp_directory_projection_assurance_1372_ck') THEN
    ALTER TABLE public.cerp_directory_projection_state ADD CONSTRAINT cerp_directory_projection_assurance_1372_ck
      CHECK ((mfa_factor_id IS NULL AND mfa_factor_version IS NULL)
        OR (mfa_factor_id IS NOT NULL AND mfa_factor_version IS NOT NULL AND mfa_factor_version>0));
  END IF;
END $$;
COMMIT;
