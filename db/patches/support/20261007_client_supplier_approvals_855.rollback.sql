-- Preserve evidence and decisions once the feature has been used.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.client_supplier_approval_scopes)
 OR EXISTS(SELECT 1 FROM public.ged_documents WHERE class_key='CERP_AGREMENT_FOURNISSEUR')
 THEN RAISE EXCEPTION 'CLIENT_APPROVAL_ROLLBACK_REQUIRES_PRESERVED_HISTORY'; END IF;
END $$;
DROP TABLE public.client_supplier_approval_members;
DROP FUNCTION public.guard_client_approval_member_insert_855();
DROP TABLE public.client_supplier_approval_revisions;
DROP TABLE public.client_supplier_approval_scopes;
DELETE FROM public.ged_document_classes WHERE class_key='CERP_AGREMENT_FOURNISSEUR';
