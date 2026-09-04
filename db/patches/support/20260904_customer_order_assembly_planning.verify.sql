\set ON_ERROR_STOP on

SELECT manufacturing_mode, assembly_supply_strategy, count(*)
FROM public.piece_technique_versions
GROUP BY manufacturing_mode, assembly_supply_strategy
ORDER BY manufacturing_mode, assembly_supply_strategy;

SELECT key, enabled, environment
FROM public.app_feature_flags
WHERE key = 'COMMAND_ASSEMBLY_FLOW';

SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('piece_technique_versions', 'commande_client')
  AND column_name IN ('manufacturing_mode', 'assembly_supply_strategy', 'internal_order_purpose', 'internal_contract_source_line_id')
ORDER BY table_name, ordinal_position;

SELECT to_regclass('public.of_component_requirements') AS component_requirements,
       to_regclass('public.internal_contract_of_allocations') AS contract_allocations;

SELECT tgname
FROM pg_trigger
WHERE tgrelid IN (
  'public.piece_technique_versions'::regclass,
  'public.ordres_fabrication'::regclass
)
  AND NOT tgisinternal
  AND tgname IN (
    'trg_assert_piece_version_manufacturing_mode',
    'trg_assert_of_assembly_components_covered'
  )
ORDER BY tgname;

SELECT conname
FROM pg_constraint
WHERE conrelid IN (
  'public.piece_technique_versions'::regclass,
  'public.commande_client'::regclass,
  'public.of_component_requirements'::regclass,
  'public.internal_contract_of_allocations'::regclass
)
ORDER BY conname;
