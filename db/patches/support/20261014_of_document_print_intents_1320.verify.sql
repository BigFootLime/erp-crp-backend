DO $$ BEGIN
  IF to_regclass('public.of_document_print_intents') IS NULL OR to_regclass('public.of_document_print_variants') IS NULL THEN
    RAISE EXCEPTION 'OF print tables are missing';
  END IF;
  IF NOT has_table_privilege('cerp_app','public.of_document_print_intents','SELECT')
    OR NOT has_table_privilege('cerp_app','public.of_document_print_intents','INSERT')
    OR has_table_privilege('cerp_app','public.of_document_print_intents','UPDATE')
    OR has_table_privilege('cerp_app','public.of_document_print_intents','DELETE') THEN
    RAISE EXCEPTION 'OF print application privileges are invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_document_print_intents
    WHERE official_ordinal IS NOT NULL GROUP BY of_id,revision_id
    HAVING MIN(official_ordinal)<>1 OR MAX(official_ordinal)<>COUNT(*)) THEN
    RAISE EXCEPTION 'OF print ordinal continuity is invalid';
  END IF;
END $$;
