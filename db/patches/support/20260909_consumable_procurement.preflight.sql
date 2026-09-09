\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'cerp_test' THEN RAISE EXCEPTION 'This execution recipe targets cerp_test'; END IF;
  IF to_regclass('public.consumable_commands') IS NOT NULL THEN RAISE EXCEPTION 'Already installed: run verify'; END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='articles' AND column_name='consumption_mode') THEN RAISE EXCEPTION 'Apply consumables article migration first'; END IF;
  IF to_regclass('public.of_material_revision_resolutions') IS NULL THEN RAISE EXCEPTION 'Missing revision prerequisite'; END IF;
END $$;
