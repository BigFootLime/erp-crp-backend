DO $$ BEGIN
 IF to_regclass('public.paiement_allocations') IS NULL OR to_regclass('public.facture') IS NULL
   OR to_regclass('public.accounting_export_source_claims') IS NULL
   OR to_regprocedure('public.fn_lock_delivery_prepayment_write_1268()') IS NULL THEN
   RAISE EXCEPTION 'ADVANCE-VAT-1268 missing prerequisites';
 END IF;
END $$;
SELECT count(*) AS historical_advance_allocations_not_backfilled
 FROM public.paiement_allocations a JOIN public.facture f ON f.id=a.facture_id
 WHERE f.immutable_snapshot->>'invoice_type_code'='386';
