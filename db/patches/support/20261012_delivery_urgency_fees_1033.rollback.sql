-- Pre-use rollback only. Never discard an accepted tariff or commercial evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.client_urgency_fee_settings,public.delivery_urgency_order_charges,public.facture_urgency_charges IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_urgency_fee_settings)
    OR EXISTS(SELECT 1 FROM public.delivery_urgency_order_charges)
    OR EXISTS(SELECT 1 FROM public.facture_urgency_charges)
    OR EXISTS(SELECT 1 FROM public.delivery_urgency_requests WHERE snapshot->'preview'->'urgency_fee' IS NOT NULL) THEN
    RAISE EXCEPTION 'Accepted urgency fees exist; retain evidence and use a forward repair';
  END IF;
END $$;
DROP TRIGGER protect_facture_urgency_line ON public.facture_ligne;
DROP TRIGGER urgency_withdrawal_charge ON public.delivery_urgency_withdrawals;
DROP TABLE public.facture_urgency_charges,public.delivery_urgency_order_charges,public.client_urgency_fee_settings;
DROP FUNCTION public.fn_protect_facture_urgency_line_1033(),public.fn_facture_urgency_charge_1033(),
  public.fn_urgency_withdrawal_charge_1033(),public.fn_urgency_charge_identity_1033();
COMMIT;
