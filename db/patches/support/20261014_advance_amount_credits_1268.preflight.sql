DO $$ BEGIN
 IF to_regclass('public.avoir_source_allocations') IS NULL
   OR to_regprocedure('public.fn_invoice_credit_total_1268(bigint,uuid)') IS NULL
   OR to_regprocedure('public.fn_lock_delivery_prepayment_write_1268()') IS NULL THEN
   RAISE EXCEPTION 'ADVANCE-AMOUNT-1268 missing refund and shared Finance prerequisites';
 END IF;
END $$;
