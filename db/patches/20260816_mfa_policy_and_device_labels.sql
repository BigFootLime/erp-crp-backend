-- DOCS-MFA-01 / issue #602 -- complete the SOL-32 MFA lifecycle.
-- Additive, transactional and replay-safe. The inserted policy preserves the
-- existing SOL-32 behaviour: superadministrators must use TOTP.

BEGIN;

DO $preflight$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'DOCS-MFA-01 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.erp_settings') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'DOCS-MFA-01 prerequisite relation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='erp_settings' AND column_name='reliability'
  ) THEN
    RAISE EXCEPTION 'DOCS-MFA-01 requires the SOL-06 erp_settings metadata columns';
  END IF;
END
$preflight$;

ALTER TABLE public.user_mfa_factors
  ADD COLUMN IF NOT EXISTS device_label text;

UPDATE public.user_mfa_factors
   SET device_label = 'Application d''authentification'
 WHERE device_label IS NULL OR btrim(device_label) = '';

ALTER TABLE public.user_mfa_factors
  ALTER COLUMN device_label SET DEFAULT 'Application d''authentification',
  ALTER COLUMN device_label SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.user_mfa_factors'::regclass
       AND conname='user_mfa_factor_device_label_ck'
  ) THEN
    ALTER TABLE public.user_mfa_factors
      ADD CONSTRAINT user_mfa_factor_device_label_ck
      CHECK (char_length(btrim(device_label)) BETWEEN 1 AND 80);
  END IF;
END
$constraints$;

INSERT INTO public.erp_settings (
  key, value_text, value_json, definition, unit, source,
  freshness_at, reliability, created_at, updated_at
)
VALUES (
  'security.mfa_policy',
  'required_for_admins',
  NULL,
  'Politique d''authentification multifacteur applicable a cette base CERP.',
  'POLICY',
  'Comportement de securite SOL-32 conserve par migration DOCS-MFA-01.',
  now(),
  'VERIFIED',
  now(),
  now()
)
ON CONFLICT (key) DO NOTHING;

DO $policy_validation$
DECLARE current_policy text;
BEGIN
  SELECT value_text INTO current_policy
    FROM public.erp_settings
   WHERE key='security.mfa_policy';
  IF current_policy NOT IN ('disabled','optional','required_for_admins','required_for_all') THEN
    RAISE EXCEPTION 'DOCS-MFA-01 invalid MFA policy: %', current_policy;
  END IF;
END
$policy_validation$;

COMMIT;
