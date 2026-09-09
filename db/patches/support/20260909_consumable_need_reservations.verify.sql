BEGIN READ ONLY;
SET LOCAL ROLE cerp_app;
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN('stock_reservations_active_legacy_source_lot_uq','stock_reservations_active_need_lot_uq');
SELECT destination_magasin_id,destination_emplacement_id FROM public.reception_fournisseur_lignes LIMIT 1;
ROLLBACK;
