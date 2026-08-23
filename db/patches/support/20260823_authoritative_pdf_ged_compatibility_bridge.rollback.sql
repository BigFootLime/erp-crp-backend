-- Test/maintenance rollback for the compatibility bridge.  Once the immutable
-- contract or cleanup has consumed the bridge, rollback is deliberately refused.
BEGIN;

DO $rollback$
DECLARE
  bridge_recorded boolean := false;
  contract_recorded boolean := false;
  marker_present boolean := to_regclass('public.cerp_authoritative_pdf_ged_bridge_20260823') IS NOT NULL;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    SELECT
      EXISTS (SELECT 1 FROM public.cerp_schema_migrations WHERE filename = '20260823_authoritative_pdf_ged_compatibility_bridge.sql'),
      EXISTS (SELECT 1 FROM public.cerp_schema_migrations WHERE filename = '20260823_authoritative_pdf_ged_entity_contract.sql')
      INTO bridge_recorded, contract_recorded;
  END IF;
  IF NOT bridge_recorded THEN
    IF marker_present THEN
      RAISE EXCEPTION 'Rollback refused: compatibility marker exists without migration-ledger ownership.';
    END IF;
    RETURN;
  END IF;
  IF marker_present THEN
    IF contract_recorded THEN
      RAISE EXCEPTION 'Rollback refused: immutable entity contract has consumed the compatibility bridge.';
    END IF;
    IF to_regclass('public.ged_entity_types') IS NULL
       OR to_regprocedure('public.fn_ged_link_guard()') IS NULL
       OR EXISTS (SELECT 1 FROM public.ged_document_links)
       OR (SELECT COUNT(*) FROM public.ged_entity_types) <> 12 THEN
      RAISE EXCEPTION 'Rollback refused: compatibility bridge state drifted.';
    END IF;
    DROP TRIGGER trg_ged_link_guard ON public.ged_document_links;
    DROP FUNCTION public.fn_ged_link_guard();
    DROP TABLE public.ged_entity_types;
    DROP TABLE public.cerp_authoritative_pdf_ged_bridge_20260823;
  ELSIF to_regclass('public.ged_entity_types') IS NULL THEN
    RAISE EXCEPTION 'Rollback refused: legacy cleanup already consumed the compatibility bridge.';
  END IF;
  DELETE FROM public.cerp_schema_migrations
   WHERE filename = '20260823_authoritative_pdf_ged_compatibility_bridge.sql';
END
$rollback$;

COMMIT;
