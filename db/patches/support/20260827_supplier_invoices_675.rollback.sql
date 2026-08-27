DO $$
BEGIN
  IF current_database() !~* '(test|isolated|scratch)' THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 rollback is allowed only on an isolated/test database';
  END IF;
  IF to_regclass('public.supplier_invoices') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.supplier_invoices) THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 rollback refused because supplier invoice evidence exists';
  END IF;
END $$;

BEGIN;
DROP TABLE IF EXISTS public.supplier_invoice_command_receipts;
DROP TABLE IF EXISTS public.supplier_invoice_provider_status_outbox;
DROP TABLE IF EXISTS public.super_pdp_sync_cursors;
DROP TABLE IF EXISTS public.supplier_invoice_decisions;
DROP TABLE IF EXISTS public.supplier_invoice_line_matches;
DROP TABLE IF EXISTS public.supplier_invoice_match_versions;
DROP TABLE IF EXISTS public.supplier_invoice_artifacts;
DROP TABLE IF EXISTS public.supplier_invoice_lines;
DROP TABLE IF EXISTS public.supplier_invoices;
DROP FUNCTION IF EXISTS public.fn_supplier_invoice_evidence_append_only_675();
DELETE FROM public.ged_document_classes WHERE class_key = 'FACTURE_FOURNISSEUR';
COMMIT;
