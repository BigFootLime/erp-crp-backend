BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_crm_events) OR EXISTS(SELECT 1 FROM public.client_crm_followups)
    OR EXISTS(SELECT 1 FROM public.client_crm_profiles) THEN
    RAISE EXCEPTION 'CRM has business records; preserve evidence and repair forward';
  END IF;
END $$;
DROP TABLE public.client_crm_events;
DROP TABLE public.client_crm_followups;
DROP TABLE public.client_crm_profiles;
DROP FUNCTION public.cerp_guard_crm_event();
COMMIT;
