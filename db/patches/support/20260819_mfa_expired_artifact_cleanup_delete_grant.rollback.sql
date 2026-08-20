\set ON_ERROR_STOP on

-- This additive grant has a known pre-migration baseline: SOL-32 granted only
-- SELECT, INSERT and UPDATE on user_mfa_factors. Roll back the matching
-- application code first; otherwise startup maintenance will fail again.
BEGIN;

DO $guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant rollback refused on database %', current_database();
  END IF;
  IF to_regclass('public.user_mfa_factors') IS NULL THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant rollback refused: user_mfa_factors is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant rollback refused: runtime role cerp_app is missing';
  END IF;
END
$guard$;

REVOKE DELETE ON TABLE public.user_mfa_factors FROM cerp_app;

COMMIT;

DO $verify_rollback$
BEGIN
  IF has_table_privilege('cerp_app', 'public.user_mfa_factors', 'DELETE') THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant rollback verification failed';
  END IF;
END
$verify_rollback$;
