-- Additive recovery only: retain frozen limits and immutable provenance.
-- Switch to the retained backend artifact during an incident; see recovery.md.
-- This support script intentionally never drops committed traceability.
DO $$ BEGIN
  IF to_regclass('public.production_consolidation_material_transfers') IS NULL THEN
    RAISE EXCEPTION 'Missing provenance table: inspect the migration state before recovery';
  END IF;
END $$;
