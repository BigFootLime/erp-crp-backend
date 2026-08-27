-- #677 - Extend SOL-27 immutable accounting exports with supplier invoices and credit notes.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.accounting_export_batches') IS NULL
     OR to_regclass('public.accounting_export_batch_sources') IS NULL
     OR to_regclass('public.accounting_export_entries') IS NULL
     OR to_regclass('public.accounting_export_source_claims') IS NULL
     OR to_regclass('public.supplier_invoices') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING-EXPORT-677 missing prerequisites';
  END IF;
END
$guard$;

ALTER TABLE public.accounting_export_batches
  DROP CONSTRAINT IF EXISTS accounting_batch_sources_sol27_ck;
ALTER TABLE public.accounting_export_batches
  ADD CONSTRAINT accounting_batch_sources_677_ck CHECK (
    cardinality(source_types) BETWEEN 1 AND 5
    AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE']::text[]
  );

ALTER TABLE public.accounting_export_batch_sources
  DROP CONSTRAINT IF EXISTS accounting_export_batch_sources_source_type_check;
ALTER TABLE public.accounting_export_batch_sources
  ADD CONSTRAINT accounting_batch_source_type_677_ck CHECK (
    source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE')
  );

ALTER TABLE public.accounting_export_entries
  DROP CONSTRAINT IF EXISTS accounting_export_entries_source_type_check;
ALTER TABLE public.accounting_export_entries
  ADD CONSTRAINT accounting_entry_source_type_677_ck CHECK (
    source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE')
  );

ALTER TABLE public.accounting_export_source_claims
  DROP CONSTRAINT IF EXISTS accounting_export_source_claims_source_type_check;
ALTER TABLE public.accounting_export_source_claims
  ADD CONSTRAINT accounting_claim_source_type_677_ck CHECK (
    source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE')
  );

COMMENT ON CONSTRAINT accounting_batch_sources_677_ck ON public.accounting_export_batches IS
  '#677 supplier invoice/credit-note sources; mappings remain versioned and no cabinet account is implicit.';

COMMIT;
