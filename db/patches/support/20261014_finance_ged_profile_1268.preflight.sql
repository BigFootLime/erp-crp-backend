DO $$ BEGIN
 IF to_regclass('public.ged_document_links') IS NULL OR
  (to_regclass('public.ged_entity_types') IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_trigger WHERE tgrelid='public.ged_document_links'::regclass
    AND tgname='trg_ged_validate_canonical_entity_link_20' AND NOT tgisinternal AND tgenabled<>'D')) THEN
  RAISE EXCEPTION 'FINANCE-GED-1268 qualified legacy or closed GED profile required';
 END IF;
END $$;
