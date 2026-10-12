-- Allowed only before the first request; preserve all business history otherwise.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.delivery_urgency_requests,public.delivery_urgency_recoveries,public.delivery_urgency_sources,public.delivery_urgency_approvals,
  public.delivery_urgency_withdrawals,public.delivery_urgency_transfers IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_requests) OR EXISTS(SELECT 1 FROM public.delivery_urgency_recoveries)
    OR EXISTS(SELECT 1 FROM public.delivery_urgency_sources) OR EXISTS(SELECT 1 FROM public.delivery_urgency_approvals)
    OR EXISTS(SELECT 1 FROM public.delivery_urgency_withdrawals) OR EXISTS(SELECT 1 FROM public.delivery_urgency_transfers) THEN
    RAISE EXCEPTION 'Urgency evidence exists; retain the migration and use a forward repair';
  END IF;
END $$;
ALTER TABLE public.delivery_urgency_requests DROP CONSTRAINT delivery_urgency_approval_owner;
ALTER TABLE public.delivery_urgency_requests DROP CONSTRAINT delivery_urgency_withdrawal_owner;
DROP TABLE public.delivery_urgency_transfers,public.delivery_urgency_withdrawals;
DROP TABLE public.delivery_urgency_approvals,public.delivery_urgency_sources,public.delivery_urgency_recoveries,public.delivery_urgency_requests;
DROP FUNCTION public.fn_delivery_urgency_request_identity_1033(),public.fn_delivery_urgency_recovery_identity_1033(),
  public.fn_delivery_urgency_source_identity_1033(),public.fn_delivery_urgency_quantities_1033(),public.fn_delivery_urgency_approval_identity_1033(),
  public.fn_delivery_urgency_withdrawal_identity_1033(),public.fn_delivery_urgency_transfer_identity_1033(),public.fn_delivery_urgency_withdrawal_balance_1033();
COMMIT;
