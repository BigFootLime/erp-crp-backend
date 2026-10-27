DO $$ BEGIN
 IF to_regclass('public.clients') IS NULL THEN RAISE EXCEPTION '1454 clients table missing'; END IF;
END $$;
