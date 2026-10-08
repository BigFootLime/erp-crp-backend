-- Retain immutable provenance; never drop committed material allocations.
-- Before any new hold is created, the previous backend artifact may be restored.
-- After use, restore the matching database recovery set or deploy a forward fix:
-- the previous backend cannot dissolve the new aggregated holds safely.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.production_consolidation_material_holds) THEN
    RAISE EXCEPTION 'New material holds exist: use a forward fix or the matching recovery set';
  END IF;
END $$;
