\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.of_material_needs') IS NULL OR to_regclass('public.planning_recalculation_jobs') IS NULL
    OR to_regprocedure('public.planning_invalidate()') IS NULL THEN RAISE EXCEPTION 'Material and central planning prerequisites missing'; END IF;
END $$;
