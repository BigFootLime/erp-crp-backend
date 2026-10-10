BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.client_contract_lines') IS NULL OR to_regclass('public.client_contract_forecasts') IS NULL
    OR to_regclass('public.client_forecast_call_allocations') IS NULL
    OR to_regprocedure('public.fn_protect_stock_immutable_evidence()') IS NULL OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'Replenishment preparation requires canonical contracts, forecast conversions and immutable evidence';
  END IF;
END $$;
ROLLBACK;
