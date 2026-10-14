-- Metadata-only rollback on an unused schema. Never remove an account, contract or company.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.test_account_registrations) OR EXISTS(SELECT 1 FROM public.erp_setup_progress)
  OR EXISTS(SELECT 1 FROM public.erp_setup_company_commands) OR EXISTS(SELECT 1 FROM public.users WHERE avatar_key IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.erp_settings WHERE key='company.primary_biller_id') THEN
  RAISE EXCEPTION 'Initial setup contains data; retain schema and use application rollback';
 END IF;
END $$;
DROP TABLE public.erp_setup_company_commands;
DROP TABLE public.erp_setup_progress;
DROP TABLE public.test_account_registrations;
ALTER TABLE public.users DROP CONSTRAINT users_avatar_key_1563_ck;
ALTER TABLE public.users DROP COLUMN avatar_key;
COMMIT;
