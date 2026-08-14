\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback SOL-22 autorise uniquement sur cerp_test; restaurer la sauvegarde en production';
  END IF;
  IF to_regclass('public.quality_cost_entry') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.quality_cost_entry) THEN
    RAISE EXCEPTION 'Rollback refuse: preuves de cout qualite presentes';
  END IF;
  IF to_regclass('public.quality_spc_policy') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.quality_spc_policy) THEN
    RAISE EXCEPTION 'Rollback refuse: politiques SPC presentes';
  END IF;
  IF EXISTS (SELECT 1 FROM public.non_conformity WHERE cause_code IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback refuse: causes structurees utilisees';
  END IF;
END $$;

BEGIN;
DROP TRIGGER IF EXISTS trg_quality_action_verification_guard_0450 ON public.quality_action;
DROP FUNCTION IF EXISTS public.quality_action_verification_guard_0450();
DROP TRIGGER IF EXISTS trg_quality_spc_policy_guard_0450 ON public.quality_spc_policy;
DROP FUNCTION IF EXISTS public.quality_spc_policy_guard_0450();
DROP TABLE IF EXISTS public.quality_spc_policy;
DROP TRIGGER IF EXISTS trg_quality_cost_entry_guard_0450 ON public.quality_cost_entry;
DROP FUNCTION IF EXISTS public.quality_cost_entry_guard_0450();
DROP TABLE IF EXISTS public.quality_cost_entry;
ALTER TABLE public.non_conformity DROP CONSTRAINT IF EXISTS non_conformity_cause_code_0450_fk;
DROP INDEX IF EXISTS public.non_conformity_cause_period_0450_idx;
ALTER TABLE public.non_conformity DROP COLUMN IF EXISTS cause_code;
DROP TABLE IF EXISTS public.quality_cause_catalog;
COMMIT;
