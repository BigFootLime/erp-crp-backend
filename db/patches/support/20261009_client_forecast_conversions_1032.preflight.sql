BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.client_contract_forecasts') IS NULL OR to_regclass('public.client_contract_call_lines') IS NULL
    OR to_regprocedure('public.fn_protect_stock_immutable_evidence()') IS NULL OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'Forecast conversions require canonical estimates and firm calls';
  END IF;
END $$;
ROLLBACK;
