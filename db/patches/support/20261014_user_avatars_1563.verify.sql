DO $$ BEGIN
  IF to_regclass('public.user_avatar_commands') IS NULL OR NOT has_table_privilege('cerp_app','public.user_avatar_commands','SELECT,INSERT') THEN
    RAISE EXCEPTION 'Avatar command registry missing or unavailable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='trg_operational_media_users_profile_picture' AND tgenabled='O') THEN
    RAISE EXCEPTION 'User media binding trigger unavailable';
  END IF;
END $$;
