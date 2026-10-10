DO $$ BEGIN
  IF to_regclass('public.client_contract_replenishment_plans') IS NULL
    OR to_regclass('public.client_contract_replenishment_proposals') IS NULL
    OR to_regclass('public.ordres_fabrication') IS NULL OR to_regclass('public.of_output_lots') IS NULL
    OR to_regclass('public.pieces_techniques') IS NULL OR to_regclass('public.piece_technique_versions') IS NULL
    OR to_regprocedure('public.fn_protect_stock_immutable_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Apply canonical production and replenishment preparation dependencies first';
  END IF;
  IF to_regclass('public.client_contract_replenishment_roots') IS NOT NULL
    OR to_regclass('public.client_contract_replenishment_launches') IS NOT NULL
    OR to_regprocedure('public.fn_client_replenishment_root_identity_1032()') IS NOT NULL THEN
    RAISE EXCEPTION 'Replenishment root schema already exists; inspect before applying';
  END IF;
END $$;
