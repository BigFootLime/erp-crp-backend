BEGIN READ ONLY;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['client_contract_forecasts','client_contract_forecast_events'] LOOP
    IF to_regclass('public.'||relation) IS NULL OR NOT has_table_privilege('cerp_app','public.'||relation,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||relation,'INSERT')
      OR has_table_privilege('cerp_app','public.'||relation,'DELETE') OR has_table_privilege('cerp_app','public.'||relation,'TRUNCATE') THEN
      RAISE EXCEPTION 'Forecast table or grants invalid: %',relation;
    END IF;
  END LOOP;
  IF has_table_privilege('cerp_app','public.client_contract_forecast_events','UPDATE')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_forecast_events'::regclass
      AND tgname='client_contract_forecast_events_immutable' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_forecasts'::regclass
      AND tgname='client_contract_forecast_identity' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_lines'::regclass
      AND tgname='client_contract_forecast_line_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Forecast evidence or identity guard missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_forecasts f JOIN public.client_contract_lines l ON l.id=f.contract_line_id
    WHERE (f.contract_id,f.root_article_id,f.unit_id) IS DISTINCT FROM (l.contract_id,l.root_article_id,l.unit_id)) THEN
    RAISE EXCEPTION 'Forecast family/unit mismatch';
  END IF;
END $$;
ROLLBACK;
