BEGIN;
DO $$ BEGIN
 IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-ged-profile-reviewed'
   OR EXISTS(SELECT 1 FROM public.ged_document_links WHERE entity_type='PROFORMA')
   OR to_regclass('public.proforma_client') IS NOT NULL THEN
  RAISE EXCEPTION 'FINANCE-GED-1268 rollback requires reviewed empty profile before Finance model';
 END IF;
END $$;
DROP TRIGGER trg_ged_finance_parent_guard_1268 ON public.ged_document_links;
DROP FUNCTION public.fn_ged_finance_parent_guard_1268();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.finance_ged_profile_state_1268 WHERE registry_created) THEN
  DROP TABLE public.ged_entity_types;
 END IF;
END $$;
DROP TABLE public.finance_ged_profile_state_1268;
COMMIT;
