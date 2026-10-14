BEGIN;
DO $$ DECLARE saved record;BEGIN
 IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-refund-reversals-reviewed' THEN
  RAISE EXCEPTION 'Refund reversal rollback requires explicit reviewed acknowledgement';
 END IF;
 IF EXISTS(SELECT 1 FROM public.customer_refund_reversals)
   OR EXISTS(SELECT 1 FROM public.accounting_export_batch_sources WHERE source_type='CUSTOMER_REFUND_REVERSAL')
   OR EXISTS(SELECT 1 FROM public.accounting_export_batches WHERE 'CUSTOMER_REFUND_REVERSAL'=ANY(source_types)) THEN
  RAISE EXCEPTION 'Refund reversal rollback refused: contains saved correction evidence';
 END IF;
 IF (SELECT count(*) FROM public.finance_refund_reversal_migration_state_1268)<>5 THEN
  RAISE EXCEPTION 'Refund reversal rollback lacks original canonical functions';
 END IF;
 FOR saved IN SELECT definition FROM public.finance_refund_reversal_migration_state_1268 ORDER BY signature LOOP
  EXECUTE saved.definition;
 END LOOP;
END $$;
DROP TRIGGER trg_lock_refund_accounting_1268 ON public.accounting_export_source_claims;
DROP TRIGGER trg_lock_refund_accounting_1268 ON public.accounting_export_batches;
DROP TRIGGER trg_retain_refund_accounting_1268 ON public.accounting_export_source_claims;
DROP TRIGGER trg_retain_refund_accounting_1268 ON public.accounting_export_batches;
DROP VIEW public.customer_refund_sources_effective_1268;
DROP VIEW public.customer_refunds_effective_1268;
DROP TABLE public.customer_refund_reversals;
DROP TABLE public.finance_refund_reversal_migration_state_1268;
DROP SEQUENCE public.customer_refund_reversal_number_seq;
DROP FUNCTION public.fn_customer_refund_reversal_write_1268();
DROP FUNCTION public.fn_lock_refund_accounting_1268();
DROP FUNCTION public.fn_retain_refund_accounting_1268();
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT accounting_batch_source_type_1268_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck
 CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT accounting_entry_source_type_1268_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck
 CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT accounting_claim_source_type_1268_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck
 CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND'));
ALTER TABLE public.accounting_export_batches DROP CONSTRAINT accounting_batch_sources_1268_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK(cardinality(source_types) BETWEEN 1 AND 7
 AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND']::text[]);
COMMIT;
