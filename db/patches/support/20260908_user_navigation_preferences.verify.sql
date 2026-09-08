DO $$ BEGIN
  IF to_regclass('public.user_navigation_preferences') IS NULL THEN RAISE EXCEPTION 'Navigation preferences table missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_navigation_preferences'::regclass AND contype = 'p') THEN RAISE EXCEPTION 'Owner uniqueness missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_navigation_preferences'::regclass AND contype = 'f') THEN RAISE EXCEPTION 'Owner foreign key missing'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AND NOT has_table_privilege('cerp_app', 'public.user_navigation_preferences', 'SELECT,INSERT,UPDATE') THEN RAISE EXCEPTION 'Application privileges missing'; END IF;
END $$;
SELECT current_database() AS verified_database, count(*) AS preference_count FROM public.user_navigation_preferences;
