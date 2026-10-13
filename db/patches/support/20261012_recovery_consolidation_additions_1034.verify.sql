DO $$ BEGIN
  IF to_regclass('public.production_recovery_consolidation_additions') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_recovery_consolidation_additions'::regclass AND tgname='recovery_consolidation_addition_complete' AND tgdeferrable AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_recovery_consolidation_additions'::regclass AND tgname='production_recovery_consolidation_additions_immutable' AND tgenabled='O')
    OR NOT has_table_privilege('cerp_app','public.production_recovery_consolidation_additions','INSERT')
    OR has_table_privilege('cerp_app','public.production_recovery_consolidation_additions','UPDATE')
    OR has_table_privilege('cerp_app','public.production_recovery_consolidation_additions','DELETE') THEN
    RAISE EXCEPTION 'Recovery addition schema or protections missing';
  END IF;
END $$;
