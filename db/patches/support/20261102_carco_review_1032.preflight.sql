\set ON_ERROR_STOP on
DO $$ BEGIN
 IF to_regclass('public.demand_pilot_imports') IS NULL OR to_regclass('public.commande_documents') IS NULL THEN
  RAISE EXCEPTION 'The demand pilot and order schema are required';
 END IF;
END $$;
