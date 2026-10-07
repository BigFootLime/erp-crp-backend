DO $$ BEGIN
 IF to_regclass('public.commercial_general_terms_selections') IS NULL
 OR ((SELECT count(*) FROM public.ged_document_classes WHERE class_key IN('CERP_CGV','CERP_CGA') AND approvals_required>=1 AND hold_on_publish)=2) IS NOT TRUE
 THEN RAISE EXCEPTION 'GENERAL_TERMS_SCHEMA_INCOMPLETE'; END IF;
END $$;
