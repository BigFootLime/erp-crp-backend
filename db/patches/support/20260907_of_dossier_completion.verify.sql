\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.of_dossier_validations') IS NULL OR to_regclass('public.of_material_commands') IS NULL THEN RAISE EXCEPTION 'Dossier tables missing'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('of_dossier_definition_changed','of_dossier_operations_changed','of_dossier_operation_changed','of_dossier_planning_changed'))<>4 THEN RAISE EXCEPTION 'Dossier triggers missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='of_dossier_planning_changed' AND tgdeferrable AND tginitdeferred) THEN RAISE EXCEPTION 'Planning move must be evaluated at commit'; END IF;
  IF NOT has_table_privilege('cerp_app','public.of_dossier_validations','SELECT,INSERT,UPDATE') OR NOT has_table_privilege('cerp_app','public.of_material_commands','SELECT,INSERT') THEN RAISE EXCEPTION 'Application grants missing'; END IF;
END $$;
SET LOCAL ROLE cerp_app;
SELECT count(*) AS validations FROM public.of_dossier_validations;
SELECT count(*) AS commands FROM public.of_material_commands;
SELECT key,enabled FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW';
COMMIT;
