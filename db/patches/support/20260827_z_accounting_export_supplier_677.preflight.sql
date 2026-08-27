-- Ordered with 20260827_z_accounting_export_supplier_677.sql after supplier invoices.
DO $preflight$
BEGIN
  IF to_regclass('public.accounting_export_batches') IS NULL
     OR to_regclass('public.accounting_export_batch_sources') IS NULL
     OR to_regclass('public.accounting_export_entries') IS NULL
     OR to_regclass('public.accounting_export_source_claims') IS NULL
     OR to_regclass('public.supplier_invoices') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING-EXPORT-677 missing prerequisites';
  END IF;
END
$preflight$;

SELECT document_type,status,count(*)
FROM public.supplier_invoices
GROUP BY document_type,status
ORDER BY document_type,status;
