\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.quality_cause_catalog') IS NULL
     OR to_regclass('public.quality_cost_entry') IS NULL
     OR to_regclass('public.quality_spc_policy') IS NULL THEN
    RAISE EXCEPTION 'Tables SOL-22 absentes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'non_conformity' AND column_name = 'cause_code'
  ) THEN
    RAISE EXCEPTION 'Colonne non_conformity.cause_code absente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_quality_cost_entry_guard_0450' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Garde append-only des couts absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_quality_spc_policy_guard_0450' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Garde de version SPC absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'quality_spc_policy_active_characteristic_0450_uq'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'Unicite de la politique SPC active absente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_quality_action_verification_guard_0450' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Garde de preuve CAPA absent';
  END IF;
END $$;

SELECT current_database() AS database_name,
       (SELECT COUNT(*) FROM public.quality_cause_catalog) AS cause_codes,
       (SELECT COUNT(*) FROM public.quality_cost_entry) AS cost_entries,
       (SELECT COUNT(*) FROM public.quality_spc_policy WHERE active) AS active_spc_policies,
       (SELECT COUNT(*) FROM public.non_conformity WHERE cause_code IS NOT NULL) AS structured_non_conformities;

SELECT COUNT(*) AS orphan_cost_entries
FROM public.quality_cost_entry c
LEFT JOIN public.non_conformity nc ON nc.id = c.non_conformity_id
WHERE nc.id IS NULL;
