BEGIN READ ONLY;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['client_contract_calls','client_contract_call_lines'] LOOP
    IF to_regclass('public.'||target) IS NULL OR NOT has_table_privilege('cerp_app','public.'||target,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||target,'INSERT') OR has_table_privilege('cerp_app','public.'||target,'UPDATE')
      OR has_table_privilege('cerp_app','public.'||target,'DELETE') OR has_table_privilege('cerp_app','public.'||target,'TRUNCATE') THEN
      RAISE EXCEPTION 'Contract call table or grants invalid: %',target;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||target)::regclass AND tgname=target||'_immutable'
      AND NOT tgisinternal AND tgenabled='O') THEN RAISE EXCEPTION 'Immutable call guard required: %',target; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.client_contract_calls call JOIN public.commande_client commande ON commande.id=call.commande_id
    WHERE commande.client_id IS DISTINCT FROM call.client_id OR commande.order_type<>'FERME') THEN RAISE EXCEPTION 'Call order identity mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_call_lines binding JOIN public.client_contract_calls call ON call.id=binding.call_id
    JOIN public.commande_ligne line ON line.id=binding.commande_ligne_id WHERE line.commande_id<>call.commande_id
      OR line.article_id IS DISTINCT FROM binding.article_id OR line.piece_technique_version_id IS DISTINCT FROM binding.piece_technique_version_id) THEN
    RAISE EXCEPTION 'Call canonical line identity mismatch'; END IF;
END $$;
ROLLBACK;
