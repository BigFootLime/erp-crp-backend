BEGIN READ ONLY;
DO $$ BEGIN
 IF to_regclass('public.test_account_registrations') IS NULL OR to_regclass('public.erp_setup_progress') IS NULL
  OR to_regclass('public.erp_setup_company_commands') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_avatar_key_1563_ck') THEN
  RAISE EXCEPTION 'Initial setup schema incomplete';
 END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.test_account_registrations','SELECT'),('public.test_account_registrations','INSERT'),
   ('public.erp_setup_company_commands','SELECT'),('public.erp_setup_company_commands','INSERT'),
   ('public.erp_setup_progress','SELECT'),('public.erp_setup_progress','INSERT'),('public.erp_setup_progress','UPDATE')
  ) AS required(relation_name,privilege_name)
  WHERE NOT has_table_privilege('cerp_app',relation_name,privilege_name)
 ) THEN RAISE EXCEPTION 'Initial setup application grants missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.test_account_registrations r JOIN public.users u ON u.id=r.user_id
   WHERE NOT u.is_superadmin OR u.avatar_key IS NULL) THEN RAISE EXCEPTION 'Test registration invariant invalid'; END IF;
END $$;
SELECT current_database() AS database,
 (SELECT count(*) FROM public.test_account_registrations) AS registration_count,
 (SELECT count(*) FROM public.erp_setup_progress) AS progress_count;
ROLLBACK;
