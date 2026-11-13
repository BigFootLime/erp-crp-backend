BEGIN READ ONLY;
DO $$ DECLARE item record; BEGIN
  IF to_regclass('public.client_forecast_call_allocations') IS NULL OR to_regclass('public.v_client_contract_forecast_coverage') IS NULL
    OR NOT has_table_privilege('cerp_app','public.client_forecast_call_allocations','SELECT')
    OR NOT has_table_privilege('cerp_app','public.client_forecast_call_allocations','INSERT')
    OR NOT has_table_privilege('cerp_app','public.v_client_contract_forecast_coverage','SELECT')
    OR has_table_privilege('cerp_app','public.client_forecast_call_allocations','UPDATE')
    OR has_table_privilege('cerp_app','public.client_forecast_call_allocations','DELETE')
    OR has_table_privilege('cerp_app','public.client_forecast_call_allocations','TRUNCATE') THEN
    RAISE EXCEPTION 'Forecast conversion tables or privileges invalid';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('client_forecast_call_allocations','client_forecast_allocations_immutable'),
    ('client_forecast_call_allocations','client_forecast_allocations_guard'),
    ('client_forecast_call_allocations','client_forecast_allocations_advance'),
    ('client_contract_forecasts','client_forecast_quantity_guard'),
    ('commande_ligne','client_forecast_firm_quantity_guard')) AS t(relation,name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||item.relation)::regclass AND tgname=item.name AND NOT tgisinternal AND tgenabled='O') THEN
      RAISE EXCEPTION 'Forecast conversion trigger missing: %',item.name;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.v_client_contract_forecast_coverage c JOIN public.client_contract_forecasts f ON f.id=c.forecast_id
    WHERE c.converted_quantity>f.quantity OR c.remaining_quantity<0)
    OR EXISTS(SELECT 1 FROM public.client_forecast_call_allocations a JOIN public.client_contract_call_lines cl ON cl.id=a.call_line_id
      JOIN public.commande_ligne line ON line.id=cl.commande_ligne_id GROUP BY line.id HAVING sum(a.quantity)>line.quantite) THEN
    RAISE EXCEPTION 'Forecast or firm quantity overallocated';
  END IF;
END $$;
ROLLBACK;
