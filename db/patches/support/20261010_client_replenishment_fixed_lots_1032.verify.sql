DO $$ BEGIN
  IF to_regprocedure('public.fn_client_replenishment_fixed_lots_1032()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_replenishment_roots'::regclass
      AND tgname='client_replenishment_fixed_lots' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='client_replenishment_roots_proposal_lot_key') THEN
    RAISE EXCEPTION 'Fixed-lot guards missing';
  END IF;
  IF has_table_privilege('cerp_app','public.client_contract_replenishment_roots','UPDATE,DELETE')
    OR NOT has_table_privilege('cerp_app','public.client_contract_replenishment_roots','SELECT')
    OR NOT has_table_privilege('cerp_app','public.client_contract_replenishment_roots','INSERT') THEN
    RAISE EXCEPTION 'Fixed-lot evidence privileges mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots r JOIN public.client_contract_replenishment_proposals p ON p.id=r.proposal_id
    WHERE r.quantity<>CASE WHEN r.lot_index IS NULL THEN p.proposed_quantity ELSE p.lot_quantity END
      OR (r.lot_index IS NOT NULL AND (r.lot_index>p.lot_count OR p.proposed_quantity<>p.lot_quantity*p.lot_count))) THEN
    RAISE EXCEPTION 'Fixed-lot quantity or position differs from immutable proposal';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots r JOIN public.client_contract_replenishment_proposals p ON p.id=r.proposal_id
    GROUP BY r.proposal_id,p.lot_count,p.proposed_quantity HAVING
      (count(r.lot_index)>0 AND (count(*)<>p.lot_count OR sum(r.quantity)<>p.proposed_quantity
        OR min(r.lot_index)<>1 OR max(r.lot_index)<>p.lot_count OR count(r.lot_index)<>count(*) OR count(DISTINCT r.launch_id)<>1))) THEN
    RAISE EXCEPTION 'Incomplete or mixed fixed-lot launch evidence';
  END IF;
END $$;
