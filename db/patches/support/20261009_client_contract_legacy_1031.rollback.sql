BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.client_contract_legacy_orders,public.client_contract_legacy_lines IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_orders) OR EXISTS(SELECT 1 FROM public.client_contract_legacy_lines) THEN
    RAISE EXCEPTION 'Historical associations are used: retain immutable evidence and restore a compatible runtime';
  END IF;
END $$;
DROP TRIGGER legacy_contract_line_identity ON public.commande_ligne;
DROP TRIGGER legacy_contract_order_identity ON public.commande_client;
DROP FUNCTION public.guard_legacy_contract_line_identity();
DROP FUNCTION public.guard_legacy_contract_order_identity();
DROP TABLE public.client_contract_legacy_lines;
DROP TABLE public.client_contract_legacy_orders;
COMMIT;
