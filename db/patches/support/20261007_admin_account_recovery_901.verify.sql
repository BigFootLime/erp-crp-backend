\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.erp_settings WHERE key='security.account_recovery_enabled' AND value_text IN ('true','false')) THEN
    RAISE EXCEPTION 'Recovery verify: rollout activation setting missing';
  END IF;
  IF to_regclass('public.admin_account_recoveries') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users'
      AND column_name='mfa_reenrollment_required' AND data_type='boolean' AND is_nullable='NO'
  ) THEN RAISE EXCEPTION 'Recovery verify: schema missing'; END IF;
  IF NOT has_table_privilege('cerp_app','public.admin_account_recoveries','SELECT,INSERT,UPDATE')
     OR has_table_privilege('cerp_app','public.admin_account_recoveries','DELETE') THEN
    RAISE EXCEPTION 'Recovery verify: evidence privileges invalid';
  END IF;
  IF to_regclass('public.admin_account_recoveries_one_pending_uq') IS NULL THEN
    RAISE EXCEPTION 'Recovery verify: pending uniqueness missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.admin_account_recoveries'::regclass
    AND tgname='admin_account_recoveries_evidence_guard' AND tgenabled='O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Recovery verify: immutable evidence guard missing';
  END IF;
END $$;
SELECT current_database() AS database,
  (SELECT count(*) FROM public.admin_account_recoveries) AS recovery_evidence_count,
  (SELECT count(*) FROM public.users WHERE mfa_reenrollment_required) AS forced_enrollment_count;
