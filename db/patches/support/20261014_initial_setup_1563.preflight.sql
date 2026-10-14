BEGIN READ ONLY;
DO $$ BEGIN
 IF to_regclass('public.users') IS NULL OR to_regclass('public.factureur') IS NULL
  OR to_regclass('public.hr_employees') IS NULL OR to_regclass('public.hr_employment_contracts') IS NULL
  OR to_regclass('public.hr_work_schedules') IS NULL OR to_regclass('public.user_role_assignments') IS NULL
  OR to_regclass('public.user_mfa_factors') IS NULL OR to_regclass('public.production_maintenance_schedules') IS NULL
  OR to_regclass('public.finance_legal_mentions') IS NULL OR to_regclass('public.planning_central_settings') IS NULL THEN
  RAISE EXCEPTION 'Initial setup prerequisites missing';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='is_superadmin')
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='mfa_reenrollment_required') THEN
  RAISE EXCEPTION 'Account security prerequisites missing';
 END IF;
END $$;
ROLLBACK;
