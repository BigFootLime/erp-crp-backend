DO $$ BEGIN
  IF to_regclass('public.operational_media_assets') IS NULL OR to_regclass('public.operational_media_bindings') IS NULL
    OR to_regprocedure('public.fn_operational_media_sync_binding()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='avatar_key') THEN
    RAISE EXCEPTION 'Apply operational media #611 and initial setup #1563 first';
  END IF;
END $$;
