BEGIN READ ONLY;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['client_contracts','client_contract_lines','client_contract_events'] LOOP
    IF to_regclass('public.'||target) IS NULL OR NOT has_table_privilege('cerp_app','public.'||target,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||target,'INSERT')
      OR has_table_privilege('cerp_app','public.'||target,'DELETE') OR has_table_privilege('cerp_app','public.'||target,'TRUNCATE') THEN
      RAISE EXCEPTION 'Contract table or grants invalid: %',target;
    END IF;
  END LOOP;
  IF has_table_privilege('cerp_app','public.client_contract_events','UPDATE') OR NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_events'::regclass
      AND tgname='client_contract_events_immutable' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Contract history must be immutable'; END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_lines line JOIN public.articles a ON a.id=line.article_id
    WHERE COALESCE(a.root_article_id,a.id)<>line.root_article_id) THEN RAISE EXCEPTION 'Contract commercial family mismatch'; END IF;
END $$;
ROLLBACK;
