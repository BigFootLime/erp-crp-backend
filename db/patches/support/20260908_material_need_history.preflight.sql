\set ON_ERROR_STOP on
SELECT current_database(),current_user;
DO $$ BEGIN
  IF to_regclass('public.of_material_revision_resolutions') IS NULL THEN RAISE EXCEPTION 'Reconciliation must be installed first'; END IF;
  IF to_regclass('public.of_material_need_current_definition_idx') IS NOT NULL THEN RAISE EXCEPTION 'Patch already installed; verify ledger'; END IF;
END $$;
