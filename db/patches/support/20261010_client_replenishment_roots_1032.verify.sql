DO $$ BEGIN
  IF to_regclass('public.client_contract_replenishment_roots') IS NULL
    OR to_regclass('public.client_contract_replenishment_launches') IS NULL
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN('client_replenishment_root_identity','client_replenishment_roots_immutable','client_replenishment_launches_immutable'))<>3 THEN
    RAISE EXCEPTION 'Replenishment root schema or guards missing';
  END IF;
  IF has_table_privilege('cerp_app','public.client_contract_replenishment_roots','UPDATE,DELETE')
    OR has_table_privilege('cerp_app','public.client_contract_replenishment_launches','UPDATE,DELETE')
    OR NOT has_table_privilege('cerp_app','public.client_contract_replenishment_roots','SELECT')
    OR NOT has_table_privilege('cerp_app','public.client_contract_replenishment_roots','INSERT')
    OR NOT has_table_privilege('cerp_app','public.client_contract_replenishment_launches','SELECT')
    OR NOT has_table_privilege('cerp_app','public.client_contract_replenishment_launches','INSERT') THEN
    RAISE EXCEPTION 'Replenishment evidence privileges mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots r
    JOIN public.client_contract_replenishment_proposals p ON p.id=r.proposal_id
    WHERE (r.plan_id,r.contract_id,r.article_id,r.unit_id,r.target_date)
      IS DISTINCT FROM (p.plan_id,p.contract_id,p.article_id,p.unit_id,p.target_date)
      OR r.quantity NOT IN (p.proposed_quantity,p.lot_quantity)
      OR r.piece_technique_id::text IS DISTINCT FROM p.article_snapshot->>'piece_technique_id'
      OR r.piece_technique_version_id::text IS DISTINCT FROM p.article_snapshot->>'piece_technique_version_id') THEN
    RAISE EXCEPTION 'Replenishment root evidence differs from its original proposal';
  END IF;
END $$;
