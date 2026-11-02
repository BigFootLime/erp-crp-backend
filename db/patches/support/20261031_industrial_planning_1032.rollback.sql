BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.industrial_plan_runs) OR EXISTS(SELECT 1 FROM public.industrial_policy_events) OR EXISTS(SELECT 1 FROM public.industrial_article_rules) OR EXISTS(SELECT 1 FROM public.industrial_contract_rules) OR EXISTS(SELECT 1 FROM public.industrial_policies) THEN
  RAISE EXCEPTION 'Archive pilot planning evidence before rollback';
 END IF;
END $$;
DROP TABLE public.industrial_policy_events,public.industrial_plan_runs,public.industrial_contract_rules,public.industrial_article_rules,public.industrial_policies;
COMMIT;
