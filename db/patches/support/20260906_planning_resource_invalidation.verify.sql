DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.machines'::regclass
    AND tgname='planning_invalidate' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Machine invalidation trigger missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass
    AND tgname='planning_invalidate_membership' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Membership invalidation trigger missing';
  END IF;
END $$;
