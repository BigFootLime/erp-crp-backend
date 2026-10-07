DO $$ BEGIN
 IF to_regclass('public.subcontract_purchase_origins') IS NULL
 OR to_regclass('public.ged_document_versions') IS NULL
 OR to_regclass('public.production_consolidation_allocations') IS NULL
 OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL
 THEN RAISE EXCEPTION 'CLIENT_APPROVAL_PREREQUISITES_MISSING'; END IF;
END $$;
