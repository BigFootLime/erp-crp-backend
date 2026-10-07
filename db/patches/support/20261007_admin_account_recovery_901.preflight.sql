\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.password_resets') IS NULL
     OR to_regclass('public.password_reset_tokens') IS NULL OR to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.user_mfa_recovery_codes') IS NULL OR to_regclass('public.auth_mfa_challenges') IS NULL
     OR to_regclass('public.realtime_session_epochs') IS NULL OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'Recovery preflight: prerequisite account and MFA schema missing';
  END IF;
END $$;
SELECT current_database() AS database, to_regclass('public.admin_account_recoveries') IS NOT NULL AS already_installed;
