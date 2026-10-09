BEGIN READ ONLY;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['client_contract_legacy_orders','client_contract_legacy_lines'] LOOP
    IF to_regclass('public.'||target) IS NULL OR NOT has_table_privilege('cerp_app','public.'||target,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||target,'INSERT') OR has_table_privilege('cerp_app','public.'||target,'UPDATE')
      OR has_table_privilege('cerp_app','public.'||target,'DELETE') OR has_table_privilege('cerp_app','public.'||target,'TRUNCATE') THEN
      RAISE EXCEPTION 'Legacy contract evidence grants invalid: %',target;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||target)::regclass
      AND tgname=target||'_immutable' AND NOT tgisinternal AND tgenabled='O') THEN
      RAISE EXCEPTION 'Immutable legacy contract evidence guard required: %',target;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.commande_client'::regclass
      AND tgname='legacy_contract_order_identity' AND NOT tgisinternal AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.commande_ligne'::regclass
      AND tgname='legacy_contract_line_identity' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION 'Canonical historical identity guards required';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_orders legacy
    JOIN public.client_contract_calls call ON call.commande_id=legacy.commande_id) THEN
    RAISE EXCEPTION 'Legacy order cannot also be a firm contract call';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_orders legacy JOIN public.commande_client commande ON commande.id=legacy.commande_id
    WHERE commande.client_id IS DISTINCT FROM legacy.client_id OR commande.order_type<>'CADRE') THEN
    RAISE EXCEPTION 'Legacy order identity mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_lines binding
    JOIN public.client_contract_legacy_orders legacy ON legacy.id=binding.legacy_order_id
    JOIN public.commande_ligne line ON line.id=binding.commande_ligne_id
    WHERE line.commande_id<>legacy.commande_id OR line.article_id IS DISTINCT FROM binding.article_id
      OR line.piece_technique_version_id IS DISTINCT FROM binding.piece_technique_version_id
      OR line.piece_technique_id::text IS DISTINCT FROM binding.historical_line->>'piece_technique_id'
      OR lower(line.unite) IS DISTINCT FROM lower(binding.historical_line->>'unit')) THEN
    RAISE EXCEPTION 'Legacy canonical line identity mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_legacy_orders legacy
    JOIN public.commande_ligne line ON line.commande_id=legacy.commande_id
    LEFT JOIN public.client_contract_legacy_lines binding ON binding.commande_ligne_id=line.id
    WHERE binding.id IS NULL) THEN RAISE EXCEPTION 'Unmapped associated historical line'; END IF;
END $$;
ROLLBACK;
