-- Never erase selected terms or an approved source when rolling back application code.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.commercial_general_terms_selections)
 OR EXISTS(SELECT 1 FROM public.ged_documents WHERE class_key IN('CERP_CGV','CERP_CGA'))
 THEN RAISE EXCEPTION 'GENERAL_TERMS_ROLLBACK_REQUIRES_PRESERVED_HISTORY'; END IF;
END $$;
DROP TABLE public.commercial_general_terms_selections;
DELETE FROM public.ged_document_classes WHERE class_key IN('CERP_CGV','CERP_CGA');
-- Keep the additive access-event vocabulary: older applications ignore these
-- names, and a rollback must not erase a recorded download or selection event.
