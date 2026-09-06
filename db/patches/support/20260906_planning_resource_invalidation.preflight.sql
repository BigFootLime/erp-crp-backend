DO $$ BEGIN
  IF to_regclass('public.user_role_assignments') IS NULL OR to_regclass('public.app_roles') IS NULL THEN
    RAISE EXCEPTION 'Canonical role tables missing';
  END IF;
END $$;
