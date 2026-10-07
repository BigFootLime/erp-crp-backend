DO $$ BEGIN
 IF to_regclass('public.client_supplier_approval_scopes') IS NULL
 OR to_regclass('public.client_supplier_approval_revisions') IS NULL
 OR to_regclass('public.client_supplier_approval_members') IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.ged_document_classes WHERE class_key='CERP_AGREMENT_FOURNISSEUR' AND domain='QUALITE' AND approvals_required>=1 AND hold_on_publish)
 THEN RAISE EXCEPTION 'CLIENT_APPROVAL_SCHEMA_INCOMPLETE'; END IF;
END $$;
