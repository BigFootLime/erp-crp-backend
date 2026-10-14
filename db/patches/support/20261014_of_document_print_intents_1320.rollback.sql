BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1320-empty-print-model-reviewed' THEN
    RAISE EXCEPTION 'OF print rollback requires explicit reviewed acknowledgement';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_document_print_intents) OR EXISTS(SELECT 1 FROM public.of_document_print_variants) THEN
    RAISE EXCEPTION 'OF print model contains saved evidence; rollback refused';
  END IF;
END $$;
DROP TABLE public.of_document_print_intents;
DROP TABLE public.of_document_print_variants;
DROP FUNCTION public.fn_of_print_intent_scope_1320();
DROP FUNCTION public.fn_of_print_evidence_immutable_1320();
DROP INDEX public.of_documents_print_scope_1320_uq;
COMMIT;
