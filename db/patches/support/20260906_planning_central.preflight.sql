-- Read-only preflight; run on each selected CERP database before applying the patch.
DO $$ BEGIN
  IF to_regclass('public.of_operations') IS NULL OR to_regclass('public.planning_events') IS NULL
    OR to_regclass('public.piece_version_programming_tasks') IS NULL
    OR to_regclass('public.production_quantity_declarations') IS NULL THEN
    RAISE EXCEPTION 'Planning central prerequisites are missing';
  END IF;
END $$;
