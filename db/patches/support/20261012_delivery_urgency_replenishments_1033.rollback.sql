-- Restore the matching previous backend before rollback. Never erase used evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.delivery_urgency_replenishments IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_replenishments) THEN
    RAISE EXCEPTION 'Retain committed replenishment evidence; use a forward correction';
  END IF;
END $$;
DROP TABLE public.delivery_urgency_replenishments;
DROP FUNCTION public.fn_delivery_urgency_replenishment_identity_1033();
DROP FUNCTION public.fn_delivery_urgency_replenishment_receipt_1033();
REVOKE UPDATE(id) ON public.delivery_urgency_recoveries FROM cerp_app;
COMMIT;
