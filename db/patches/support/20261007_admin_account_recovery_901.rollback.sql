\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.admin_account_recoveries,public.users IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.admin_account_recoveries)
     OR EXISTS(SELECT 1 FROM public.users WHERE mfa_reenrollment_required) THEN
    RAISE EXCEPTION 'Recovery rollback refused: evidence or mandatory reenrollment exists; retain schema and compatible backend';
  END IF;
END $$;
DROP TABLE public.admin_account_recoveries;
DROP FUNCTION public.cerp_guard_account_recovery_evidence();
ALTER TABLE public.users DROP COLUMN mfa_reenrollment_required;
DELETE FROM public.erp_settings WHERE key='security.account_recovery_enabled';
COMMIT;
