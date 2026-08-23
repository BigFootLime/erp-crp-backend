\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ged_document_classes
     WHERE class_key = 'IMAGE_ENTITE'
       AND nature = 'SOURCE'
       AND is_active
       AND allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp']::text[]
       AND max_size_bytes = 10485760
  ) THEN
    RAISE EXCEPTION 'GED203_VERIFY_IMAGE_CLASS_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_ged_validate_gamme_entity_link_203' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'GED203_VERIFY_GAMME_TRIGGER_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.ged_document_links l
      LEFT JOIN public.gammes g ON g.id::text = l.entity_id
     WHERE l.entity_type = 'GAMME' AND g.id IS NULL
  ) THEN
    RAISE EXCEPTION 'GED203_VERIFY_STALE_GAMME_LINKS';
  END IF;
END;
$$;

SELECT class_key, domain, label, nature, max_size_bytes, is_active
  FROM public.ged_document_classes
 WHERE class_key = 'IMAGE_ENTITE';
