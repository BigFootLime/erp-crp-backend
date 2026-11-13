-- Refuse after first policy projection. Restore a qualified database snapshot instead.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.cerp_company_policy_projections) THEN RAISE EXCEPTION 'Company policies have been projected; an inspected restoration plan is required'; END IF;
END $$;
DROP TABLE public.cerp_company_policy_projections;
COMMIT;
