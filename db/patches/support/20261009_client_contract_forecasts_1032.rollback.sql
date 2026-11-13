-- Only unused development/test installation. Used estimates are retained.
BEGIN;
LOCK TABLE public.client_contract_forecasts,public.client_contract_forecast_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_forecasts) OR EXISTS(SELECT 1 FROM public.client_contract_forecast_events) THEN
    RAISE EXCEPTION 'Forecast history exists; use a forward correction';
  END IF;
END $$;
DROP TRIGGER client_contract_forecast_line_guard ON public.client_contract_lines;
DROP TABLE public.client_contract_forecast_events;
DROP TABLE public.client_contract_forecasts;
DROP FUNCTION public.fn_client_contract_forecast_identity_1032();
DROP FUNCTION public.fn_client_contract_forecast_line_guard_1032();
COMMIT;
