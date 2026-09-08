\set ON_ERROR_STOP on
SELECT current_database(),current_user;
DO $$ BEGIN
  IF to_regclass('public.of_material_needs') IS NULL OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL THEN RAISE EXCEPTION 'Material workflow prerequisites missing'; END IF;
  IF to_regclass('public.of_material_revision_resolutions') IS NOT NULL THEN RAISE EXCEPTION 'Patch already installed; verify ledger'; END IF;
END $$;
