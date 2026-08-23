-- Closed-registry databases treat cleanup as a no-op and may unregister it in
-- test.  Rehydrating a consumed production bridge is intentionally refused.
BEGIN;

DO $rollback$
DECLARE
  cleanup_recorded boolean := false;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.cerp_schema_migrations
       WHERE filename = '20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql'
    ) INTO cleanup_recorded;
  END IF;
  IF NOT cleanup_recorded THEN
    RETURN;
  END IF;
  IF to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback refused: compatibility marker unexpectedly remains after cleanup.';
  END IF;
  IF to_regclass('public.ged_entity_types') IS NULL THEN
    RAISE EXCEPTION 'Rollback refused: production legacy cleanup is not automatically reversible.';
  END IF;
  IF to_regprocedure('public.fn_ged_link_guard()') IS NULL THEN
    RAISE EXCEPTION 'Rollback refused: closed GED registry profile drifted.';
  END IF;
  DELETE FROM public.cerp_schema_migrations
   WHERE filename = '20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql';
END
$rollback$;

COMMIT;
