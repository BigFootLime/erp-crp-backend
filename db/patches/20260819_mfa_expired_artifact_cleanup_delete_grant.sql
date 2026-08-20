-- CERP-REPAIR-00 — the MFA maintenance job removes expired PENDING factors
-- only after their expired challenges have been removed. The runtime role
-- therefore needs this single, explicit DELETE privilege.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant refused on database %', current_database();
  END IF;
  IF to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.auth_mfa_challenges') IS NULL THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant refused: MFA relations are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup grant refused: runtime role cerp_app is missing';
  END IF;
END
$guard$;

-- Do not broaden the MFA runtime role. cleanupExpiredMfaArtifacts deletes only
-- expired PENDING factors after deleting their challenge rows.
GRANT DELETE ON TABLE public.user_mfa_factors TO cerp_app;

COMMIT;
