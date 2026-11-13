DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pieces_techniques_achats' AND column_name='gamme_operation_id') THEN RAISE EXCEPTION 'Missing operation link'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pieces_techniques_achats'::regclass AND tgname='guard_version_purchase_712' AND tgenabled='O') THEN RAISE EXCEPTION 'Purchase guard missing'; END IF;
END $$;
