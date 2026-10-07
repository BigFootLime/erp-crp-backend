-- Only unused schema may be removed; real evidence is never discarded.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.supplier_review_scopes) OR EXISTS(SELECT 1 FROM public.supplier_review_commands) THEN RAISE EXCEPTION 'SUPPLIER_REVIEW_RECOVERY_REQUIRES_FORWARD_FIX'; END IF;
END $$;
DROP TABLE public.supplier_review_commands,public.supplier_review_evaluations,public.supplier_review_policies,public.supplier_review_scopes;
-- Keep the GED class: an uploaded document may already reference it.
