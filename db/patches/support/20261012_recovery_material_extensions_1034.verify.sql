DO $$ BEGIN
  IF to_regclass('public.production_recovery_material_extensions') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_recovery_material_extensions'::regclass AND tgname='recovery_material_extension_allocation' AND tgdeferrable)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_recovery_material_extensions'::regclass AND tgname='production_recovery_material_extensions_immutable')
    OR NOT has_table_privilege('cerp_app','public.production_recovery_material_extensions','INSERT')
    OR has_table_privilege('cerp_app','public.production_recovery_material_extensions','UPDATE')
    OR has_table_privilege('cerp_app','public.production_recovery_material_extensions','DELETE') THEN
    RAISE EXCEPTION 'Recovery material extension schema, privileges or constraints missing';
  END IF;
END $$;
