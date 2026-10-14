BEGIN;
DO $$ DECLARE saved public.finance_refund_migration_state_1268%ROWTYPE;table_name text;BEGIN
 IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-model-reviewed' THEN
   RAISE EXCEPTION 'Customer refund rollback requires explicit reviewed acknowledgement';
 END IF;
 IF EXISTS(SELECT 1 FROM public.customer_refunds) OR EXISTS(SELECT 1 FROM public.accounting_export_batch_sources WHERE source_type='CUSTOMER_REFUND')
   OR EXISTS(SELECT 1 FROM public.accounting_export_batches WHERE 'CUSTOMER_REFUND'=ANY(source_types))
   OR EXISTS(SELECT 1 FROM public.paiement_allocations WHERE advance_vat_snapshot->>'version'='2') THEN
   RAISE EXCEPTION 'Customer refund rollback refused: contains saved refund evidence';
 END IF;
 SELECT * INTO saved FROM public.finance_refund_migration_state_1268 WHERE id=true;
 IF saved.id IS NULL THEN RAISE EXCEPTION 'Customer refund rollback lacks original canonical functions'; END IF;
 EXECUTE saved.prior_allocation_function;EXECUTE saved.prior_final_function;EXECUTE saved.prior_cash_vat_function;
 FOREACH table_name IN ARRAY ARRAY['facture','avoir','avoir_source_allocations','paiement','paiement_allocations','customer_refunds','customer_refund_sources'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS trg_check_customer_refunds_1268 ON public.%I',table_name);
 END LOOP;
END $$;
DROP TABLE public.customer_refund_sources;
DROP TABLE public.customer_refunds;
DROP TABLE public.finance_refund_migration_state_1268;
DROP SEQUENCE public.customer_refund_number_seq;
DROP FUNCTION public.fn_check_customer_refunds_1268();
DROP FUNCTION public.fn_customer_refund_write_1268();
DROP FUNCTION public.fn_invoice_credit_total_1268(bigint,uuid);
DROP FUNCTION public.fn_invoice_cash_total_1268(bigint,bigint);
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT accounting_batch_source_type_1268_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT accounting_entry_source_type_1268_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT accounting_claim_source_type_1268_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT'));
ALTER TABLE public.accounting_export_batches DROP CONSTRAINT accounting_batch_sources_1268_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK(cardinality(source_types) BETWEEN 1 AND 6
  AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT']::text[]);
COMMIT;
