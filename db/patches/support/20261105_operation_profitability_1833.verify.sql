DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pieces_techniques_operations' AND column_name='prix_vente_horaire' AND is_nullable='YES') THEN RAISE EXCEPTION 'Missing optional operation selling rate'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='operation_prix_vente_horaire_positive') THEN RAISE EXCEPTION 'Missing selling-rate bounds'; END IF;
END $$;
