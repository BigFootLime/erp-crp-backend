BEGIN READ ONLY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients'
    AND column_name='client_id' AND udt_name IN('varchar','text')) THEN RAISE EXCEPTION 'Canonical client identity required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='units'
    AND column_name='id' AND udt_name='uuid') THEN RAISE EXCEPTION 'Canonical unit UUID required'; END IF;
  IF to_regclass('public.article_client_links') IS NULL OR to_regclass('public.piece_technique_versions') IS NULL
    OR to_regprocedure('public.fn_protect_stock_immutable_evidence()') IS NULL THEN RAISE EXCEPTION 'Contract catalog prerequisites missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN RAISE EXCEPTION 'Runtime role missing'; END IF;
END $$;
ROLLBACK;
