\set ON_ERROR_STOP on

DO $verify$
DECLARE current_policy text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='user_mfa_factors' AND column_name='device_label'
       AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'device_label is missing or nullable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.user_mfa_factors'::regclass
       AND conname='user_mfa_factor_device_label_ck'
  ) THEN
    RAISE EXCEPTION 'device label constraint is missing';
  END IF;
  SELECT value_text INTO current_policy
    FROM public.erp_settings
   WHERE key='security.mfa_policy';
  IF current_policy NOT IN ('disabled','optional','required_for_admins','required_for_all') THEN
    RAISE EXCEPTION 'MFA policy is absent or invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_mfa_factors
     WHERE device_label IS NULL OR char_length(btrim(device_label)) NOT BETWEEN 1 AND 80
  ) THEN
    RAISE EXCEPTION 'Invalid MFA device labels remain';
  END IF;
END
$verify$;

SELECT
  (SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy') AS policy,
  (SELECT count(*) FROM public.user_mfa_factors WHERE state='ACTIVE') AS active_factors,
  (SELECT count(*) FROM public.user_mfa_factors WHERE state='PENDING' AND pending_expires_at <= now()) AS expired_pending_factors;
