-- Ordered with 20260827_z_einvoice_credit_reporting_676.sql after supplier invoices.
DO $preflight$
BEGIN
  IF to_regclass('public.avoir') IS NULL
     OR to_regclass('public.facture') IS NULL
     OR to_regclass('public.paiement') IS NULL
     OR to_regclass('public.einvoice_billing_frame_catalog') IS NULL
     OR to_regclass('public.einvoice_documents') IS NULL
     OR to_regclass('public.supplier_invoices') IS NULL THEN
    RAISE EXCEPTION 'EINVOICE-676 missing prerequisites';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'EINVOICE-676 runtime role cerp_app is missing';
  END IF;
END
$preflight$;

SELECT
  to_regclass('public.einvoice_reporting_transactions') IS NULL AS reporting_not_yet_installed,
  count(*) FILTER (WHERE statut = 'ISSUED') AS issued_credit_notes_to_qualify
FROM public.avoir;
