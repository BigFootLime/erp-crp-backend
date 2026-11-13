DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='gamme_operation_finitions_operation_slot_uq') THEN RAISE EXCEPTION 'Missing two-finish slot identity'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pieces_techniques_achats'::regclass AND tgname='guard_purchase_capacity_1833' AND tgenabled='O') THEN RAISE EXCEPTION 'Missing material/finish capacity guard'; END IF;
END $$;
