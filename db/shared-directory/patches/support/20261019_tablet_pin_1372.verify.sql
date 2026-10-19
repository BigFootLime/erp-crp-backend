DO $$ BEGIN
 IF to_regclass('public.cerp_directory_tablet_pins') IS NULL OR to_regclass('public.cerp_directory_tablet_devices') IS NULL THEN RAISE EXCEPTION 'Tablet PIN Directory schema missing'; END IF;
 IF has_table_privilege('cerp_app','public.cerp_directory_tablet_pins','SELECT') OR has_table_privilege('cerp_app','public.cerp_directory_tablet_devices','SELECT') THEN RAISE EXCEPTION 'Site runtime must not read Directory tablet PIN credentials'; END IF;
END $$;
