DO $$ BEGIN
 IF current_database() NOT IN ('cerp_prod','cerp_test') AND current_database() !~ '^cerp_test_[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Shared directory fixed/managed site required'; END IF;
 IF to_regclass('public.user_avatar_commands') IS NULL OR to_regclass('public.erp_setup_progress') IS NULL OR to_regclass('public.operator_device_sessions') IS NULL THEN RAISE EXCEPTION 'Apply initial_setup1563 and user_avatars1563 prerequisites'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='avatar_key') THEN RAISE EXCEPTION 'Avatar prerequisite missing'; END IF;
END $$;
SELECT current_database() AS target_database,(SELECT count(*) FROM public.users) AS preserved_user_rows;
