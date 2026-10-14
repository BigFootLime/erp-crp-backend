DO $$ BEGIN
 IF to_regclass('public.paiement_allocations') IS NULL OR to_regprocedure('public.fn_invoice_applied_prepayment_1268(bigint)') IS NULL
   OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.paiement_allocations'::regclass AND attname='advance_vat_snapshot' AND NOT attisdropped)
   OR position('incoming_invoice_credit' IN pg_get_functiondef('public.fn_validate_facturation_allocation_227()'::regprocedure))=0 THEN
   RAISE EXCEPTION 'CUSTOMER-REFUND-1268 missing canonical allocation and advance prerequisites';
 END IF;
END $$;
