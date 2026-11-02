BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_portal_operational_notices) THEN RAISE EXCEPTION 'Operational notices exist; retain schema and let them expire instead.'; END IF;
END $$;
DROP TABLE IF EXISTS public.client_portal_operational_notices;
DROP FUNCTION IF EXISTS public.fn_client_portal_operational_notice_scope_1805();
COMMIT;
