\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE cerp_app;
DO $$ BEGIN
  IF to_regclass('public.consumable_commands') IS NULL OR to_regclass('public.consumable_receipt_admissions') IS NULL THEN RAISE EXCEPTION 'Missing consumable ledgers'; END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commande_fournisseur_ligne' AND column_name='prix_unitaire_ht' AND is_nullable='NO') THEN RAISE EXCEPTION 'Unknown draft price still forbidden'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='revision_resolution_one_command') THEN RAISE EXCEPTION 'Revision command constraint missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='consumable_receipt_admissions_immutable' AND tgenabled='O') THEN RAISE EXCEPTION 'Admission audit protection missing'; END IF;
END $$;
SELECT count(*) AS commands FROM public.consumable_commands;
SELECT count(*) AS admissions FROM public.consumable_receipt_admissions;
ROLLBACK;
