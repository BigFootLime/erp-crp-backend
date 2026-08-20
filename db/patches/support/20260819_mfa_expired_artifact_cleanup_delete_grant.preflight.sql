\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant preflight refused on database %', current_database();
  END IF;
  IF to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.auth_mfa_challenges') IS NULL THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant preflight refused: MFA relations are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant preflight refused: runtime role cerp_app is missing';
  END IF;
END
$guard$;

SELECT current_database() AS database_name,
       has_table_privilege('cerp_app', 'public.user_mfa_factors', 'DELETE')
         AS can_delete_expired_pending_factors,
       count(*) FILTER (WHERE state = 'PENDING' AND pending_expires_at <= now())
         AS expired_pending_factor_count,
       now() AS checked_at
  FROM public.user_mfa_factors;

COMMIT;
