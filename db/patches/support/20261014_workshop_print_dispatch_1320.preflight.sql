BEGIN READ ONLY;
DO $$ DECLARE object text; BEGIN
  FOREACH object IN ARRAY ARRAY['ordres_fabrication','of_operations','of_revisions','planning_events','planning_tasks',
    'of_document_print_intents','of_workshop_folders','of_workshop_folder_prints','of_dossier_validations'] LOOP
    IF to_regclass('public.'||object) IS NULL THEN RAISE EXCEPTION 'Workshop dispatch prerequisite missing: %',object; END IF;
  END LOOP;
  IF to_regprocedure('public.fn_of_print_evidence_immutable_1320()') IS NULL THEN RAISE EXCEPTION 'Workshop print evidence guard missing'; END IF;
END $$;
ROLLBACK;
