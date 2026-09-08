\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.of_customer_material_calls') IS NULL OR to_regclass('public.of_customer_material_receipt_transfers') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_guard_customer_material_receipt_767' AND tgenabled<>'D')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='reception_origin_check' AND convalidated)
    THEN RAISE EXCEPTION 'Customer material receipt verification failed'; END IF;
END $$;
SELECT 'customer material calls, canonical receipts, ownership guard: verified' AS result;
