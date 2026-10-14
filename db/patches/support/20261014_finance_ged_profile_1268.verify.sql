DO $$ BEGIN
 IF to_regclass('public.ged_entity_types') IS NULL OR
  NOT has_table_privilege('cerp_app','public.ged_entity_types','SELECT') OR
  has_table_privilege('cerp_app','public.finance_ged_profile_state_1268','SELECT') OR NOT EXISTS(
   SELECT 1 FROM pg_trigger WHERE tgrelid='public.ged_document_links'::regclass
    AND tgname='trg_ged_finance_parent_guard_1268' AND tgenabled='O' AND NOT tgisinternal
    AND tgfoid='public.fn_ged_finance_parent_guard_1268()'::regprocedure) THEN
  RAISE EXCEPTION 'FINANCE-GED-1268 private metadata and parent guard required';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM pg_trigger WHERE tgrelid='public.ged_document_links'::regclass
   AND NOT tgisinternal AND tgenabled<>'D' AND (
    (tgname='trg_ged_validate_canonical_entity_link_20' AND tgfoid=to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')) OR
    (tgname='trg_ged_link_guard' AND tgfoid=to_regprocedure('public.fn_ged_link_guard()')))) THEN
  RAISE EXCEPTION 'FINANCE-GED-1268 retain the original canonical profile guard';
 END IF;
END $$;
