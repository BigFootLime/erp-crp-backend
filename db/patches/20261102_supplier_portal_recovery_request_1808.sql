BEGIN;
ALTER TABLE public.supplier_portal_accounts ADD COLUMN IF NOT EXISTS recovery_requested_at timestamptz;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,UPDATE ON public.supplier_portal_accounts TO cerp_app;
END IF; END $$;
COMMIT;
