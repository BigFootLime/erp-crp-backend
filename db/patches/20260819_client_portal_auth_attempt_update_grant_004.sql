-- CERP-AUDIT-004 — activation and login mark their rate-limit attempt as
-- successful. The runtime role needs UPDATE only for that state transition.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 grant refused on database %', current_database();
  END IF;
  IF to_regclass('public.client_portal_auth_attempts') IS NULL THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 grant refused: client_portal_auth_attempts is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 grant refused: runtime role cerp_app is missing';
  END IF;
END
$guard$;

-- No broad privilege: this is required solely by
-- repoMarkPortalAuthAttemptSuccess after a successful portal activation/login.
GRANT UPDATE ON TABLE public.client_portal_auth_attempts TO cerp_app;

COMMIT;
