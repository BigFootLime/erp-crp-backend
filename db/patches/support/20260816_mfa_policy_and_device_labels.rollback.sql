\set ON_ERROR_STOP on

BEGIN;

DO $rollback_guard$
DECLARE current_policy text;
BEGIN
  SELECT value_text INTO current_policy
    FROM public.erp_settings
   WHERE key='security.mfa_policy';
  IF current_policy IS DISTINCT FROM 'required_for_admins' THEN
    RAISE EXCEPTION 'rollback refused: MFA policy was changed after migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_mfa_factors
     WHERE device_label IS DISTINCT FROM 'Application d''authentification'
  ) THEN
    RAISE EXCEPTION 'rollback refused: user-defined MFA device labels exist';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.user_mfa_factors f
      JOIN public.users u ON u.id=f.user_id
     WHERE f.state IN ('ACTIVE','REVOKED') AND u.is_superadmin IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'rollback refused: non-superadmin MFA lifecycle evidence exists';
  END IF;
END
$rollback_guard$;

DELETE FROM public.erp_settings WHERE key='security.mfa_policy';

ALTER TABLE public.user_mfa_factors
  DROP CONSTRAINT IF EXISTS user_mfa_factor_device_label_ck,
  DROP COLUMN IF EXISTS device_label;

COMMIT;
