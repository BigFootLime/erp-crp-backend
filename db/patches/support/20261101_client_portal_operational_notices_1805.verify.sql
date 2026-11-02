DO $$ BEGIN
  IF to_regclass('public.client_portal_operational_notices') IS NULL THEN RAISE EXCEPTION 'Missing client_portal_operational_notices'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_portal_operational_notices'::regclass AND tgname='trg_client_portal_operational_notice_scope_1805' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Missing portal operational notice scope trigger'; END IF;
END $$;
