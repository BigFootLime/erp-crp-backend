DO $$ BEGIN
  IF to_regclass('public.users') IS NULL THEN RAISE EXCEPTION 'users table required'; END IF;
END $$;
SELECT current_database() AS target_database, to_regclass('public.user_navigation_preferences') AS existing_table;
