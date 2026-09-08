\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL ROLE cerp_app;
SELECT count(stock_unit) AS captured_units,count(stock_conversion_coef) AS captured_conversions FROM public.reception_fournisseur_lignes;
SELECT idempotency_key,request_hash FROM public.reception_fournisseur_stock_receipts LIMIT 0;
SELECT tgname FROM pg_trigger WHERE tgrelid='public.reception_fournisseur_lignes'::regclass AND tgname='preserve_receipt_stock_conversion';
COMMIT;
