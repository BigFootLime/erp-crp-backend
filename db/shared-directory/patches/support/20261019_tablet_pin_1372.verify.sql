DO $$ BEGIN
IF to_regclass('public.cerp_directory_tablet_pins') IS NULL OR to_regclass('public.cerp_directory_tablet_devices') IS NULL OR to_regclass('public.cerp_directory_tablet_rate_limits') IS NULL THEN RAISE EXCEPTION 'Tablet PIN Directory schema missing'; END IF;
IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cerp_directory_tablet_devices' AND column_name='profile_id') THEN RAISE EXCEPTION 'Tablet devices must remain neutral shared assets'; END IF;
IF NOT has_column_privilege('cerp_directory_app','public.cerp_directory_tablet_devices','device_secret_hash','SELECT') OR NOT has_table_privilege('cerp_directory_app','public.cerp_directory_tablet_rate_limits','UPDATE') THEN RAISE EXCEPTION 'Directory runtime privileges missing'; END IF;
IF has_table_privilege('cerp_app','public.cerp_directory_tablet_pins','SELECT') OR has_table_privilege('cerp_app','public.cerp_directory_tablet_devices','SELECT') OR has_table_privilege('cerp_app','public.cerp_directory_tablet_rate_limits','SELECT') THEN RAISE EXCEPTION 'Site runtime must not read Directory tablet credentials'; END IF;
END $$;
