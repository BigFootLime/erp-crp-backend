\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 grant preflight refused on database %', current_database();
  END IF;
  IF to_regclass('public.client_portal_auth_attempts') IS NULL THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 grant preflight refused: client_portal_auth_attempts is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 grant preflight refused: runtime role cerp_app is missing';
  END IF;
END
$guard$;

SELECT has_table_privilege('cerp_app', 'public.client_portal_auth_attempts', 'UPDATE')
  AS can_mark_portal_auth_attempt_success;

COMMIT;
