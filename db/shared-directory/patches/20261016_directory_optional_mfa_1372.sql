-- Explicit product decision: ordinary employees may opt into MFA. Owner and
-- business-admin account requirements and every enrolled factor remain binding.
-- Schema preparation does not activate that policy. Keep the current value
-- until the compatible Directory binary has been verified, then use the audited
-- deployment operation to switch the authority and both sites together.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$'
     OR to_regclass('public.cerp_directory_sessions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='mfa_required') THEN
    RAISE EXCEPTION 'Optional MFA authority prerequisites are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_settings WHERE key='security.mfa_policy' AND value_text IN ('required_for_all','optional')) THEN
    RAISE EXCEPTION 'Unexpected source MFA policy; reconcile before applying';
  END IF;
END $$;
ALTER TABLE public.cerp_directory_sessions
  ALTER COLUMN mfa_factor_id DROP NOT NULL,
  ALTER COLUMN mfa_factor_version DROP NOT NULL,
  ALTER COLUMN mfa_verified_at DROP NOT NULL,
  ALTER COLUMN mfa_method DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_directory_sessions'::regclass AND conname='cerp_directory_sessions_assurance_1372_ck') THEN
    ALTER TABLE public.cerp_directory_sessions ADD CONSTRAINT cerp_directory_sessions_assurance_1372_ck
      CHECK ((mfa_factor_id IS NULL AND mfa_factor_version IS NULL AND mfa_verified_at IS NULL AND mfa_method IS NULL)
        OR (mfa_factor_id IS NOT NULL AND mfa_factor_version IS NOT NULL AND mfa_factor_version>0 AND mfa_verified_at IS NOT NULL AND mfa_method IS NOT NULL));
  END IF;
END $$;
UPDATE public.users u SET mfa_required=true
  WHERE NOT u.mfa_required AND (u.is_superadmin OR EXISTS (
    SELECT 1 FROM public.cerp_directory_profiles p JOIN public.cerp_directory_memberships m USING(profile_id)
    WHERE p.user_id=u.id AND m.is_superadmin
  ));
COMMIT;
