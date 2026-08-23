-- #612 rollback — only safe before a producer has written archive records.
-- It is a no-op on an entirely unapplied schema. If similarly named artifacts
-- exist without the canonical migration-ledger record, it refuses rather than
-- guessing ownership or deleting operator configuration.
BEGIN;
DO $$
DECLARE
  has_rows boolean;
  patch_recorded boolean := false;
  target_exists boolean;
  class_owned boolean := false;
  snapshot_class_owned boolean := false;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.cerp_schema_migrations WHERE filename = $1)'
      INTO patch_recorded
      USING '20260823_authoritative_pdf_archive_612.sql';
  END IF;

  target_exists := to_regclass('public.authoritative_pdf_archives') IS NOT NULL
    OR to_regclass('public.authoritative_pdf_archive_outbox') IS NOT NULL
    OR to_regclass('public.authoritative_pdf_archive_snapshot_lookup_idx') IS NOT NULL
    OR to_regclass('public.authoritative_pdf_archive_outbox_ready_idx') IS NOT NULL
    OR to_regclass('public.authoritative_pdf_archive_outbox_stale_idx') IS NOT NULL
    OR to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NOT NULL
    OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_stamp_612()') IS NOT NULL
    OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_complete_612()') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN ('trg_authoritative_pdf_archive_immutable_612', 'trg_authoritative_pdf_archive_outbox_stamp_612', 'trg_authoritative_pdf_archive_outbox_complete_612')
    );
  IF NOT patch_recorded THEN
    IF target_exists THEN
      RAISE EXCEPTION 'Rollback refused: #612 artifacts exist without canonical migration-ledger ownership.';
    END IF;
    RETURN;
  END IF;
  IF to_regclass('public.authoritative_pdf_archives') IS NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox') IS NULL THEN
    RAISE EXCEPTION 'Rollback refused: #612 migration ledger is present but archive artifacts are incomplete.';
  END IF;
  IF to_regclass('public.ged_document_classes') IS NULL THEN
    RAISE EXCEPTION 'Rollback refused: GED class registry is missing.';
  END IF;
  EXECUTE $ownership$
    SELECT EXISTS (
      SELECT 1 FROM public.ged_document_classes c
       WHERE c.class_key = 'CERP_AUTHORITATIVE_PDF'
         AND c.domain = 'CERP'
         AND c.label = 'PDF sortant autoritatif'
         AND c.nature = 'GENERATED'
         AND c.allowed_mime_types = ARRAY['application/pdf']::text[]
         AND c.allowed_extensions = ARRAY['pdf']::text[]
         AND c.max_size_bytes = 52428800::bigint
         AND c.approvals_required = 0::smallint
         AND c.retention_months = 120
         AND c.hold_on_publish = false
         AND c.is_active = true
    )
  $ownership$ INTO class_owned;
  IF NOT class_owned THEN
    RAISE EXCEPTION 'Rollback refused: #612 GED class is missing or its policy changed.';
  END IF;
  EXECUTE $snapshot_ownership$
    SELECT EXISTS (
      SELECT 1 FROM public.ged_document_classes c
       WHERE c.class_key = 'CERP_SYSTEM_SNAPSHOT' AND c.domain = 'CERP'
         AND c.label = 'Instantané interne de création' AND c.nature = 'GENERATED'
         AND c.allowed_mime_types = ARRAY['application/pdf']::text[] AND c.allowed_extensions = ARRAY['pdf']::text[]
         AND c.max_size_bytes = 52428800::bigint AND c.approvals_required = 0::smallint
         AND c.retention_months = 120 AND c.hold_on_publish = false AND c.is_active = true
    )
  $snapshot_ownership$ INTO snapshot_class_owned;
  IF NOT snapshot_class_owned THEN
    RAISE EXCEPTION 'Rollback refused: #612 system snapshot GED class is missing or its policy changed.';
  END IF;

  -- Dynamic SQL is intentional: PL/pgSQL may resolve a static table reference
  -- before the IF guard runs, which would make an unapplied schema fail here.
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.authoritative_pdf_archives)' INTO has_rows;
  IF has_rows THEN
    RAISE EXCEPTION 'Rollback refused: authoritative PDF archive records exist.';
  END IF;

  IF to_regclass('public.ged_documents') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.ged_documents WHERE class_key = ''CERP_AUTHORITATIVE_PDF'')' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'Rollback refused: authoritative PDF GED documents exist.';
    END IF;
  END IF;
  IF to_regclass('public.ged_documents') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.ged_documents WHERE class_key = ''CERP_SYSTEM_SNAPSHOT'')' INTO has_rows;
    IF has_rows THEN RAISE EXCEPTION 'Rollback refused: system snapshot GED documents exist.'; END IF;
  END IF;

  -- The ledger proves ownership; if a referenced operator configuration exists
  -- without it, the function returned above without touching the class.
  EXECUTE 'DELETE FROM public.ged_document_classes WHERE class_key = ''CERP_AUTHORITATIVE_PDF''';
  EXECUTE 'DELETE FROM public.ged_document_classes WHERE class_key = ''CERP_SYSTEM_SNAPSHOT''';
END $$;

DROP TABLE IF EXISTS public.authoritative_pdf_archive_outbox;
DROP TABLE IF EXISTS public.authoritative_pdf_archives;
DROP FUNCTION IF EXISTS public.fn_authoritative_pdf_archive_outbox_stamp_612();
DROP FUNCTION IF EXISTS public.fn_authoritative_pdf_archive_outbox_complete_612();
DROP FUNCTION IF EXISTS public.fn_authoritative_pdf_archive_immutable_612();
DO $$
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.cerp_schema_migrations WHERE filename = $1'
      USING '20260823_authoritative_pdf_archive_612.sql';
  END IF;
END $$;
COMMIT;
