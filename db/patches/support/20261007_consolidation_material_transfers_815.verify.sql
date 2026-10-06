DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordres_fabrication'::regclass
    AND tgname='of_material_origin_limit_815' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Frozen material origin limit guard missing';
  END IF;
  IF to_regclass('public.production_consolidation_material_transfers') IS NULL THEN
    RAISE EXCEPTION 'Material transfer provenance table missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_consolidation_material_transfers'::regclass
    AND tgname='production_consolidation_material_transfers_immutable' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Immutable material transfer guard missing';
  END IF;
END $$;
