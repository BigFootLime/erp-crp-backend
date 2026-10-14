BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.user_avatar_commands) THEN RAISE EXCEPTION 'Refusing rollback after avatar use'; END IF;
END $$;
DROP TABLE public.user_avatar_commands;
COMMIT;
