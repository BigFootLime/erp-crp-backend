DO $$ BEGIN
 IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$' THEN RAISE EXCEPTION '1454 target must be the private Directory'; END IF;
 IF to_regclass('public.cerp_directory_profiles') IS NULL OR to_regclass('public.erp_audit_logs') IS NULL OR to_regclass('public.cerp_directory_memberships') IS NULL THEN RAISE EXCEPTION '1454 prerequisites missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.cerp_directory_memberships'::regclass AND contype='c' AND conkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.cerp_directory_memberships'::regclass AND attname='database_id' AND NOT attisdropped) AND array_length(conkey,1)=1) THEN RAISE EXCEPTION '1454 legacy Directory site-id constraint missing'; END IF;
 IF to_regclass('public.cerp_directory_sessions') IS NULL THEN RAISE EXCEPTION '1454 switch-session prerequisite missing'; END IF;
END $$;
