DO $$ DECLARE object text; BEGIN
  FOREACH object IN ARRAY ARRAY['of_workshop_folders','of_workshop_folder_copies','of_workshop_folder_prints','of_workshop_folder_preparations'] LOOP
    IF to_regclass('public.'||object) IS NULL OR NOT has_table_privilege('cerp_app','public.'||object,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||object,'INSERT')
      OR has_table_privilege('cerp_app','public.'||object,'UPDATE') OR has_table_privilege('cerp_app','public.'||object,'DELETE') THEN
      RAISE EXCEPTION 'Workshop folder privileges invalid for %',object;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.of_workshop_folders folder WHERE
    NOT EXISTS(SELECT 1 FROM public.of_workshop_folder_copies copy WHERE copy.folder_id=folder.id
      AND copy.copy_mark=CASE WHEN folder.document_status='OFFICIEL' THEN 'ORIGINAL' ELSE folder.document_status END)
    OR (folder.document_status='OFFICIEL' AND NOT EXISTS(SELECT 1 FROM public.of_workshop_folder_copies copy
      WHERE copy.folder_id=folder.id AND copy.copy_mark='DUPLICATA'))) THEN
    RAISE EXCEPTION 'Workshop folder is missing a required immutable copy';
  END IF;
END $$;
