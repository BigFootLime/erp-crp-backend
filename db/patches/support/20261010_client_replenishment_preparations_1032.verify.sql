BEGIN READ ONLY;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['client_contract_replenishment_plans','client_contract_replenishment_proposals','client_contract_replenishment_events'] LOOP
    IF to_regclass('public.'||relation) IS NULL OR NOT has_table_privilege('cerp_app','public.'||relation,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||relation,'INSERT')
      OR has_table_privilege('cerp_app','public.'||relation,'DELETE') OR has_table_privilege('cerp_app','public.'||relation,'TRUNCATE') THEN
      RAISE EXCEPTION 'Replenishment preparation table or grants invalid: %',relation;
    END IF;
  END LOOP;
  IF has_table_privilege('cerp_app','public.client_contract_replenishment_proposals','UPDATE')
    OR has_table_privilege('cerp_app','public.client_contract_replenishment_events','UPDATE')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_replenishment_plans'::regclass AND tgname='client_replenishment_plan_identity' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_replenishment_proposals'::regclass AND tgname='client_replenishment_proposals_immutable' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_replenishment_proposals'::regclass AND tgname='client_replenishment_proposal_identity' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_replenishment_events'::regclass AND tgname='client_replenishment_events_immutable' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_contract_lines'::regclass AND tgname='client_replenishment_line_guard' AND NOT tgisinternal)
    OR to_regclass('public.client_replenishment_current_plan_idx') IS NULL THEN
    RAISE EXCEPTION 'Replenishment immutable evidence or single-current guard missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_proposals p JOIN public.client_contract_lines l ON l.id=p.contract_line_id
    JOIN public.client_contract_replenishment_plans plan ON plan.id=p.plan_id
    WHERE (p.contract_id,p.root_article_id,p.unit_id) IS DISTINCT FROM (l.contract_id,l.root_article_id,l.unit_id)
      OR p.month<plan.start_month OR p.month>=(plan.start_month+make_interval(months=>plan.months))::date
      OR p.target_overdue IS DISTINCT FROM (p.target_date<plan.as_of_date)) THEN
    RAISE EXCEPTION 'Replenishment family, unit, horizon or target mismatch';
  END IF;
END $$;
ROLLBACK;
