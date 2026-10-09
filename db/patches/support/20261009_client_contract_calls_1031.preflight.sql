BEGIN READ ONLY;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['client_contracts','client_contract_lines','commande_client','commande_ligne','piece_technique_versions','units'] LOOP
    IF to_regclass('public.'||target) IS NULL THEN RAISE EXCEPTION 'Contract call prerequisite missing: %',target; END IF;
  END LOOP;
  IF to_regprocedure('public.fn_protect_stock_immutable_evidence()') IS NULL THEN RAISE EXCEPTION 'Immutable evidence guard required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN RAISE EXCEPTION 'Runtime role required'; END IF;
  FOREACH target IN ARRAY ARRAY['commande_client','commande_ligne'] LOOP
    IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=target
      AND column_name='id' AND udt_name IN('int4','int8')) THEN RAISE EXCEPTION 'Canonical order identity invalid: %',target; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commande_ligne'
    AND column_name='piece_technique_version_id' AND udt_name='uuid') THEN RAISE EXCEPTION 'Canonical technical version required'; END IF;
END $$;
ROLLBACK;
