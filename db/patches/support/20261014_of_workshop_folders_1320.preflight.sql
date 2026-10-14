DO $$ BEGIN
  IF to_regclass('public.of_document_print_intents') IS NULL OR to_regprocedure('public.fn_of_print_evidence_immutable_1320()') IS NULL THEN
    RAISE EXCEPTION 'Workshop folder requires the OF print model';
  END IF;
END $$;
