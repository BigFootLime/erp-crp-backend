DO $$ BEGIN
 IF to_regclass('public.cerp_directory_projection_state') IS NULL OR to_regclass('public.cerp_directory_approved_actor_bindings') IS NULL OR to_regclass('public.cerp_directory_actor_state') IS NULL OR to_regclass('public.cerp_directory_work_profile_bindings') IS NULL THEN RAISE EXCEPTION 'Company directory projection objects missing'; END IF;
END $$;
SELECT current_database() AS target_database;
DO $$ BEGIN
 IF has_table_privilege('cerp_app','public.cerp_directory_approved_actor_bindings','INSERT') OR has_table_privilege('cerp_app','public.cerp_directory_approved_actor_bindings','UPDATE') THEN RAISE EXCEPTION 'Actor approval must remain privileged'; END IF;
END $$;
