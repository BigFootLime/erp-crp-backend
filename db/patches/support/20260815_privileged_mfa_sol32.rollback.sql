-- Rollback is permitted only before any factor has been activated. Once MFA
-- was enrolled, deploy the previous application and retain the evidence.
BEGIN;

DO $rollback_guard$
DECLARE
  active_or_historic bigint := 0;
BEGIN
  IF to_regclass('public.user_mfa_factors') IS NOT NULL THEN
    EXECUTE $$SELECT count(*) FROM public.user_mfa_factors WHERE state <> 'PENDING'$$ INTO active_or_historic;
  END IF;
  IF active_or_historic > 0 THEN
    RAISE EXCEPTION 'SOL-32 rollback refused: enrolled or revoked MFA evidence exists';
  END IF;
END
$rollback_guard$;

DROP TABLE IF EXISTS public.auth_mfa_challenges;
DROP TABLE IF EXISTS public.user_mfa_recovery_codes;
DROP TABLE IF EXISTS public.user_mfa_factors;

COMMIT;

DO $verify_rollback$
BEGIN
  IF to_regclass('public.user_mfa_factors') IS NOT NULL
     OR to_regclass('public.user_mfa_recovery_codes') IS NOT NULL
     OR to_regclass('public.auth_mfa_challenges') IS NOT NULL THEN
    RAISE EXCEPTION 'SOL-32 rollback verification failed';
  END IF;
END
$verify_rollback$;
