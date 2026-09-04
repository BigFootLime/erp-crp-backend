\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.app_feature_flags
     WHERE key = 'COMMAND_ASSEMBLY_FLOW'
       AND enabled = true
  ) THEN
    RAISE EXCEPTION 'Rollback refused: disable COMMAND_ASSEMBLY_FLOW before removing the assembly schema';
  END IF;

  IF EXISTS (SELECT 1 FROM public.of_component_requirements LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.internal_contract_of_allocations LIMIT 1)
     OR EXISTS (
       SELECT 1
         FROM public.commande_client
        WHERE internal_order_purpose <> 'STANDARD'
           OR internal_contract_source_line_id IS NOT NULL
        LIMIT 1
     )
     OR EXISTS (
       SELECT 1
         FROM public.stock_reservations
        WHERE of_component_requirement_id IS NOT NULL
        LIMIT 1
     ) THEN
    RAISE EXCEPTION 'Rollback refused: assembly or internal-contract operational data already exists';
  END IF;
END
$$;

DELETE FROM public.app_feature_flags
WHERE key = 'COMMAND_ASSEMBLY_FLOW';

ALTER TABLE public.stock_reservations
  DROP COLUMN IF EXISTS of_component_requirement_id;

DROP TABLE IF EXISTS public.internal_contract_of_allocations;

DROP TRIGGER IF EXISTS trg_assert_of_assembly_components_covered
  ON public.ordres_fabrication;
DROP FUNCTION IF EXISTS public.fn_assert_of_assembly_components_covered();

DROP TABLE IF EXISTS public.of_component_requirements;

ALTER TABLE public.commande_client
  DROP CONSTRAINT IF EXISTS commande_client_internal_order_purpose_ck,
  DROP COLUMN IF EXISTS internal_contract_source_line_id,
  DROP COLUMN IF EXISTS internal_order_purpose;

DROP TRIGGER IF EXISTS trg_assert_piece_version_manufacturing_mode
  ON public.piece_technique_versions;
DROP FUNCTION IF EXISTS public.fn_assert_piece_version_manufacturing_mode();

ALTER TABLE public.piece_technique_versions
  DROP CONSTRAINT IF EXISTS piece_technique_versions_assembly_supply_strategy_ck,
  DROP CONSTRAINT IF EXISTS piece_technique_versions_manufacturing_mode_ck,
  DROP COLUMN IF EXISTS assembly_supply_strategy,
  DROP COLUMN IF EXISTS manufacturing_mode;

COMMIT;
