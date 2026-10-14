DO $$ BEGIN
 IF to_regclass('public.customer_refunds') IS NULL OR to_regclass('public.customer_refund_sources') IS NULL
   OR to_regprocedure('public.fn_invoice_credit_total_1268(bigint,uuid)') IS NULL
   OR to_regprocedure('public.fn_invoice_cash_total_1268(bigint,bigint)') IS NULL
   OR NOT has_table_privilege('cerp_app','public.customer_refunds','INSERT')
   OR (SELECT count(*) FROM pg_trigger WHERE tgname='trg_customer_refund_write_1268' AND tgenabled='O')<>2
   OR has_table_privilege('cerp_app','public.finance_refund_migration_state_1268','SELECT')
   OR position('fn_invoice_credit_total_1268' IN pg_get_functiondef('public.fn_validate_facturation_allocation_227()'::regprocedure))=0
   OR position('credit-adjusted cash basis' IN pg_get_functiondef('public.fn_advance_cash_vat_1268()'::regprocedure))=0 THEN
   RAISE EXCEPTION 'CUSTOMER-REFUND-1268 verification failed';
 END IF;
END $$;
