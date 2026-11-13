DO $$ BEGIN
  IF to_regclass('public.client_contract_replenishment_roots') IS NULL
    OR to_regprocedure('public.fn_client_replenishment_root_identity_1032()') IS NULL THEN
    RAISE EXCEPTION 'Apply anticipated root dependencies first';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.client_contract_replenishment_roots'::regclass AND attname='lot_index' AND NOT attisdropped)
    OR to_regprocedure('public.fn_client_replenishment_fixed_lots_1032()') IS NOT NULL THEN
    RAISE EXCEPTION 'Fixed-lot installation already exists; inspect before applying';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots r JOIN public.client_contract_replenishment_proposals p ON p.id=r.proposal_id
    WHERE r.quantity<>p.proposed_quantity) THEN RAISE EXCEPTION 'Legacy replenishment evidence must be reconciled before migration'; END IF;
END $$;
