\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.v_of_material_need_destinations') IS NULL THEN RAISE EXCEPTION 'Material revision view missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='of_material_revision_resolutions_immutable' AND tgenabled='O') THEN RAISE EXCEPTION 'Immutable revision history trigger missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.of_material_revision_resolutions r JOIN public.of_material_needs old ON old.id=r.previous_need_id LEFT JOIN public.of_material_needs target ON target.id=r.target_need_id WHERE old.of_id<>r.of_id OR target.of_id<>r.of_id) THEN RAISE EXCEPTION 'Cross OF revision link'; END IF;
END $$;
SELECT source_need_id,target_need_id FROM public.v_of_material_need_destinations LIMIT 0;
SELECT 'material revision reconciliation: verified' AS result;
