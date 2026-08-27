DO $$
BEGIN
  IF to_regclass('public.supplier_invoices') IS NULL
     OR to_regclass('public.supplier_invoice_lines') IS NULL
     OR to_regclass('public.supplier_invoice_artifacts') IS NULL
     OR to_regclass('public.supplier_invoice_match_versions') IS NULL
     OR to_regclass('public.supplier_invoice_line_matches') IS NULL
     OR to_regclass('public.supplier_invoice_decisions') IS NULL
     OR to_regclass('public.super_pdp_sync_cursors') IS NULL
     OR to_regclass('public.supplier_invoice_provider_status_outbox') IS NULL
     OR to_regclass('public.supplier_invoice_command_receipts') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ged_document_classes WHERE class_key = 'FACTURE_FOURNISSEUR') THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 GED class is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'supplier_invoice%append_only_675' AND NOT tgisinternal) <> 5 THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 append-only triggers are incomplete';
  END IF;
END $$;

SELECT status, count(*) FROM public.supplier_invoices GROUP BY status ORDER BY status;
SELECT provider_code, stream, last_provider_id, last_success_at, last_error_code FROM public.super_pdp_sync_cursors;
