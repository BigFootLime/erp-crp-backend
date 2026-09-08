\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database(),current_user;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['of_material_commands','stock_reservations','stock_batches','lots','commande_fournisseur_ligne_besoin','reception_fournisseur_stock_receipts','clients'] LOOP
  IF to_regclass('public.'||relation) IS NULL THEN RAISE EXCEPTION 'Missing prerequisite %',relation; END IF;
 END LOOP;
END $$;
SELECT status,count(*) FROM public.stock_reservations GROUP BY status;
SELECT count(*) AS existing_purchase_allocations FROM public.commande_fournisseur_ligne_besoin;
COMMIT;
