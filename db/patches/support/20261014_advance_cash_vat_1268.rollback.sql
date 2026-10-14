BEGIN;
DO $$ BEGIN
 IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-model-reviewed' THEN
   RAISE EXCEPTION 'Advance VAT rollback requires explicit reviewed acknowledgement';
 END IF;
 IF EXISTS(SELECT 1 FROM public.paiement_allocations WHERE advance_vat_snapshot IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.accounting_export_batch_sources WHERE source_type='ADVANCE_VAT')
   OR EXISTS(SELECT 1 FROM public.accounting_export_batches WHERE 'ADVANCE_VAT'=ANY(source_types)) THEN
   RAISE EXCEPTION 'Advance VAT rollback refused: contains saved cash evidence';
 END IF;
END $$;
DROP TRIGGER IF EXISTS trg_advance_cash_vat_1268 ON public.paiement_allocations;
DROP FUNCTION IF EXISTS public.fn_advance_cash_vat_1268();
ALTER TABLE public.paiement_allocations DROP COLUMN advance_vat_snapshot;
ALTER TABLE public.accounting_export_batches DROP COLUMN only_unexported;
ALTER TABLE public.accounting_export_batches DROP CONSTRAINT accounting_batch_sources_1268_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_677_ck CHECK (
  cardinality(source_types) BETWEEN 1 AND 5 AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE']::text[]);
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT accounting_batch_source_type_1268_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_677_ck CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT accounting_entry_source_type_1268_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_677_ck CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT accounting_claim_source_type_1268_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_677_ck CHECK(source_type IN('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE'));
COMMIT;
