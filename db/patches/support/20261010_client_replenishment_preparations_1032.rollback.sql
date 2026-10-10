-- Unused development/test installation only; preparations and history remain recoverable.
BEGIN;
LOCK TABLE public.client_contract_replenishment_plans,public.client_contract_replenishment_proposals,public.client_contract_replenishment_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_plans)
    OR EXISTS(SELECT 1 FROM public.client_contract_replenishment_proposals)
    OR EXISTS(SELECT 1 FROM public.client_contract_replenishment_events) THEN
    RAISE EXCEPTION 'Replenishment evidence exists; use a forward correction';
  END IF;
END $$;
DROP TRIGGER client_replenishment_line_guard ON public.client_contract_lines;
DROP TABLE public.client_contract_replenishment_events;
DROP TABLE public.client_contract_replenishment_proposals;
DROP TABLE public.client_contract_replenishment_plans;
DROP FUNCTION public.fn_client_replenishment_plan_identity_1032();
DROP FUNCTION public.fn_client_replenishment_proposal_identity_1032();
DROP FUNCTION public.fn_client_replenishment_line_guard_1032();
COMMIT;
