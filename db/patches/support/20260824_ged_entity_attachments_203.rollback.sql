\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ged_documents WHERE class_key = 'IMAGE_ENTITE') THEN
    RAISE EXCEPTION 'GED203_ROLLBACK_REFUSED: IMAGE_ENTITE documents exist; preserve them or restore the pre-migration backup';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_validate_gamme_entity_link_203 ON public.ged_document_links;
DROP FUNCTION IF EXISTS public.fn_ged_validate_gamme_entity_link_203();
DELETE FROM public.ged_document_classes WHERE class_key = 'IMAGE_ENTITE';
