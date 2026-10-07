DO $$ BEGIN
  IF to_regclass('public.of_material_needs') IS NULL OR to_regclass('public.of_revisions') IS NULL
    OR to_regclass('public.piece_technique_versions') IS NULL OR to_regclass('public.fournisseurs') IS NULL
    OR to_regclass('public.magasins') IS NULL OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL
    THEN RAISE EXCEPTION 'Purchase preparation prerequisites missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN RAISE EXCEPTION 'Runtime role missing'; END IF;
END $$;
