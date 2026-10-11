-- Allowed only before the first request; preserve all business history otherwise.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.delivery_urgency_requests,public.delivery_urgency_recoveries,public.delivery_urgency_sources IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_requests) OR EXISTS(SELECT 1 FROM public.delivery_urgency_recoveries)
    OR EXISTS(SELECT 1 FROM public.delivery_urgency_sources) THEN
    RAISE EXCEPTION 'Urgency evidence exists; retain the migration and use a forward repair';
  END IF;
END $$;
DROP TABLE public.delivery_urgency_sources,public.delivery_urgency_recoveries,public.delivery_urgency_requests;
DROP FUNCTION public.fn_delivery_urgency_request_identity_1033(),public.fn_delivery_urgency_recovery_identity_1033(),
  public.fn_delivery_urgency_source_identity_1033(),public.fn_delivery_urgency_quantities_1033();
COMMIT;
