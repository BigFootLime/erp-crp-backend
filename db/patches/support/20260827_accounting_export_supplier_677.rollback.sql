DO $rollback$
BEGIN
  IF current_database() !~* '(test|isolated|scratch)' THEN
    RAISE EXCEPTION 'ACCOUNTING-EXPORT-677 rollback is allowed only on an isolated/test database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.accounting_export_batch_sources
    WHERE source_type IN ('SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE')
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING-EXPORT-677 rollback refused because supplier accounting evidence exists';
  END IF;
END
$rollback$;

ALTER TABLE public.accounting_export_batches DROP CONSTRAINT IF EXISTS accounting_batch_sources_677_ck;
ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_sol27_ck CHECK (
  cardinality(source_types) BETWEEN 1 AND 3
  AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT']::text[]
);
ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT IF EXISTS accounting_batch_source_type_677_ck;
ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_export_batch_sources_source_type_check CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT'));
ALTER TABLE public.accounting_export_entries DROP CONSTRAINT IF EXISTS accounting_entry_source_type_677_ck;
ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_export_entries_source_type_check CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT'));
ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT IF EXISTS accounting_claim_source_type_677_ck;
ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_export_source_claims_source_type_check CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT'));
