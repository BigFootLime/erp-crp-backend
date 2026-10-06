DO $$ BEGIN
  IF to_regclass('public.production_consolidations') IS NULL OR to_regclass('public.of_material_needs') IS NULL
    OR to_regclass('public.production_material_remnants') IS NULL THEN
    RAISE EXCEPTION 'Physical consolidation/material prerequisites missing';
  END IF;
END $$;
