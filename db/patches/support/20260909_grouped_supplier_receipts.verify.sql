\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE cerp_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='supplier_receipt_confirmation_consistent') THEN RAISE EXCEPTION 'Confirmation consistency constraint missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commande_fournisseur_ligne' AND column_name='receipt_consumption_mode') THEN RAISE EXCEPTION 'Order policy snapshot missing'; END IF;
END $$;
SELECT confirmation_state,count(*) FROM public.receptions_fournisseurs GROUP BY confirmation_state;
ROLLBACK;
