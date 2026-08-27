DO $$
BEGIN
  IF to_regclass('public.einvoice_documents') IS NULL
     OR to_regclass('public.fournisseurs') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL
     OR to_regclass('public.reception_fournisseur_lignes') IS NULL
     OR to_regclass('public.procurement_policy_versions') IS NULL
     OR to_regclass('public.ged_documents') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER-INVOICES-675 missing prerequisites';
  END IF;
END $$;

SELECT
  to_regclass('public.supplier_invoices') IS NULL AS supplier_invoices_not_yet_installed,
  to_regclass('public.super_pdp_sync_cursors') IS NULL AS cursor_not_yet_installed;
