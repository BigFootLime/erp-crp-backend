-- Unused installation only; retain every conversion once used.
BEGIN;
LOCK TABLE public.client_forecast_call_allocations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.client_forecast_call_allocations) THEN
  RAISE EXCEPTION 'Firm conversion evidence exists; use a forward correction';
END IF; END $$;
DROP VIEW public.v_client_contract_forecast_coverage;
DROP TRIGGER client_forecast_quantity_guard ON public.client_contract_forecasts;
DROP TRIGGER client_forecast_firm_quantity_guard ON public.commande_ligne;
DROP TABLE public.client_forecast_call_allocations;
DROP FUNCTION public.fn_client_forecast_allocation_guard_1032();
DROP FUNCTION public.fn_client_forecast_allocation_advance_1032();
DROP FUNCTION public.fn_client_forecast_quantity_guard_1032();
DROP FUNCTION public.fn_client_forecast_firm_quantity_guard_1032();
ALTER TABLE public.client_contract_forecasts DROP CONSTRAINT client_forecasts_allocation_scope_key;
ALTER TABLE public.client_contract_call_lines DROP CONSTRAINT client_call_lines_allocation_scope_key;
COMMIT;
