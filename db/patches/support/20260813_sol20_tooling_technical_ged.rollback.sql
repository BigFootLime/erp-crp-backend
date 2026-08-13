\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.outillage_lifecycle_events LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.outillage_allocations LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.piece_version_tool_requirements LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.outillage_tool_parameter_versions LIMIT 1) THEN
    RAISE EXCEPTION 'SOL20_ROLLBACK_REFUSED: business rows exist; restore the pre-migration backup or archive/export them explicitly';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_validate_canonical_entity_link_20 ON public.ged_document_links;
DROP FUNCTION IF EXISTS public.fn_ged_validate_canonical_entity_link_20();
DROP TRIGGER IF EXISTS trg_outillage_parameter_period_no_overlap_20 ON public.outillage_tool_parameter_versions;
DROP FUNCTION IF EXISTS public.fn_outillage_parameter_period_no_overlap_20();
DROP TRIGGER IF EXISTS trg_outillage_lifecycle_event_immutable_20 ON public.outillage_lifecycle_events;
DROP FUNCTION IF EXISTS public.fn_outillage_lifecycle_event_immutable_20();
DROP TABLE IF EXISTS public.outillage_lifecycle_events;
DROP TABLE IF EXISTS public.outillage_allocations;
DROP TABLE IF EXISTS public.piece_version_tool_requirements;
DROP TABLE IF EXISTS public.outillage_tool_parameter_versions;
