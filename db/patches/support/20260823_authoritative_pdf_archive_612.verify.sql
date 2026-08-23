-- #612 verification — read-only and fail-closed on an incomplete runtime contract.
BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.authoritative_pdf_archives') IS NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_TABLE_MISSING';
  END IF;
  IF to_regclass('public.ged_document_classes') IS NULL
     OR to_regclass('public.ged_documents') IS NULL
     OR to_regclass('public.ged_document_versions') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_GED_PREREQUISITE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_APP_ROLE_MISSING';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_UUID_GENERATOR_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'authoritative_pdf_archive_outbox'
       AND column_name = 'claim_token' AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_LEASE_TOKEN_MISSING';
  END IF;
  IF NOT EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_GED_CLASS_INCOMPATIBLE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ged_document_classes c
     WHERE c.class_key = 'CERP_SYSTEM_SNAPSHOT' AND c.domain = 'CERP'
       AND c.label = 'Instantané interne de création' AND c.nature = 'GENERATED'
       AND c.allowed_mime_types = ARRAY['application/pdf']::text[] AND c.allowed_extensions = ARRAY['pdf']::text[]
       AND c.max_size_bytes = 52428800::bigint AND c.approvals_required = 0::smallint
       AND c.retention_months = 120 AND c.hold_on_publish = false AND c.is_active = true
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_SYSTEM_SNAPSHOT_CLASS_INCOMPATIBLE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archives'::regclass
       AND conname = 'authoritative_pdf_archive_document_version_uq'
       AND contype = 'u'
       AND regexp_replace(upper(pg_get_constraintdef(oid)), '\s+', ' ', 'g') LIKE '%UNIQUE (ENTITY_TYPE, ENTITY_ID, DOCUMENT_KIND, DOCUMENT_VERSION)%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archives'::regclass
       AND conname = 'authoritative_pdf_archive_idempotency_uq'
       AND contype = 'u'
       AND regexp_replace(upper(pg_get_constraintdef(oid)), '\s+', ' ', 'g') LIKE '%UNIQUE (IDEMPOTENCY_KEY)%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archives'::regclass
       AND conname = 'authoritative_pdf_archive_complete_ck'
       AND contype = 'c'
       AND upper(pg_get_constraintdef(oid)) LIKE '%ARCHIVED_AT IS NULL%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%PDF_SHA256 IS NOT NULL%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%GED_DOCUMENT_ID IS NOT NULL%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%GED_VERSION_ID IS NOT NULL%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archives'::regclass
       AND conname = 'authoritative_pdf_archive_pdf_size_ck'
       AND contype = 'c'
       AND upper(pg_get_constraintdef(oid)) LIKE '%PDF_SIZE_BYTES <= 52428800%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'authoritative_pdf_archive_snapshot_lookup_idx'
       AND upper(indexdef) LIKE '%(ENTITY_TYPE, ENTITY_ID, DOCUMENT_KIND, SNAPSHOT_SHA256)%'
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_ARCHIVE_VERSIONING_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archive_outbox'::regclass
       AND conname = 'authoritative_pdf_archive_outbox_archive_uq'
       AND contype = 'u'
       AND regexp_replace(upper(pg_get_constraintdef(oid)), '\s+', ' ', 'g') LIKE '%UNIQUE (ARCHIVE_ID)%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archive_outbox'::regclass
       AND conname = 'authoritative_pdf_archive_outbox_lifecycle_ck'
       AND contype = 'c'
       AND upper(pg_get_constraintdef(oid)) LIKE '%STATUS = ''ARCHIVED''%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%ARCHIVED_AT IS NOT NULL%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%LOCKED_AT IS NOT NULL%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%LOCKED_BY IS NOT NULL%'
       AND upper(pg_get_constraintdef(oid)) LIKE '%CLAIM_TOKEN IS NOT NULL%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.authoritative_pdf_archive_outbox'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%PENDING%'
       AND pg_get_constraintdef(oid) LIKE '%PROCESSING%'
       AND pg_get_constraintdef(oid) LIKE '%ARCHIVED%'
       AND pg_get_constraintdef(oid) LIKE '%FAILED%'
  ) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_OUTBOX_STATUS_CONSTRAINT_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_authoritative_pdf_archive_immutable_612'
       AND tgrelid = 'public.authoritative_pdf_archives'::regclass
       AND tgfoid = to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()')
       AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_authoritative_pdf_archive_outbox_stamp_612'
       AND tgrelid = 'public.authoritative_pdf_archive_outbox'::regclass
       AND tgfoid = to_regprocedure('public.fn_authoritative_pdf_archive_outbox_stamp_612()')
       AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_authoritative_pdf_archive_outbox_complete_612'
       AND tgrelid = 'public.authoritative_pdf_archive_outbox'::regclass
       AND tgfoid = to_regprocedure('public.fn_authoritative_pdf_archive_outbox_complete_612()')
       AND NOT tgisinternal
  ) OR to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_stamp_612()') IS NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_outbox_complete_612()') IS NULL THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_VERIFY_IMMUTABILITY_MISSING';
  END IF;
END;
$$;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'authoritative_pdf_archives'
      AND column_name = 'document_version' AND data_type = 'integer'
  ) AS archive_document_version_present,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'authoritative_pdf_archives'
      AND column_name = 'source_revision'
  ) AS archive_source_revision_present,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'authoritative_pdf_archive_outbox'
      AND column_name = 'claim_token' AND data_type = 'uuid'
  ) AS outbox_claim_token_present,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'authoritative_pdf_archive_outbox_ready_idx') AS outbox_ready_index_present,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'authoritative_pdf_archive_outbox_stale_idx') AS outbox_stale_lease_index_present,
  EXISTS (SELECT 1 FROM public.ged_document_classes WHERE class_key = 'CERP_SYSTEM_SNAPSHOT') AS system_snapshot_class_present,
  has_table_privilege('cerp_app', 'public.authoritative_pdf_archives', 'SELECT,INSERT,UPDATE') AS app_archive_privileges,
  has_table_privilege('cerp_app', 'public.authoritative_pdf_archive_outbox', 'SELECT,INSERT,UPDATE') AS app_outbox_privileges;

COMMIT;
