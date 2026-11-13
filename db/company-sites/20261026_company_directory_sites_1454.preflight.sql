-- Dedicated provisioning script; excluded from the automatic business patch runner.
DO $$ BEGIN
 IF current_database() !~ '^cerp_company_[a-f0-9]{32}_(prod|test)$' THEN RAISE EXCEPTION 'Company directory site required'; END IF;
 IF to_regclass('public.users') IS NULL OR to_regclass('public.operator_device_sessions') IS NULL THEN RAISE EXCEPTION 'Projection prerequisites missing'; END IF;
END $$;
SELECT current_database() AS target_database,(SELECT count(*) FROM public.users) AS preserved_user_rows;
