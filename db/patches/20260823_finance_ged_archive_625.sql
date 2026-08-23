-- #625 — Byte-exact legal facture/avoir filing through the #612 archive outbox.
-- The bytes are retained only until the GED archive worker has filed them; the
-- immutable registry is the durable retry source when GED storage is degraded.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.authoritative_pdf_archives') IS NULL
     OR to_regclass('public.authoritative_pdf_archive_outbox') IS NULL
     OR to_regprocedure('public.fn_authoritative_pdf_archive_immutable_612()') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_612_PREREQUISITE_MISSING';
  END IF;
  -- PostgreSQL's bytea digest is the database-side integrity backstop for the
  -- exact legal source.  Do not rely only on a Node worker to notice tampering.
  IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_DIGEST_PREREQUISITE_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='authoritative_pdf_archives'
       AND column_name IN ('exact_pdf_bytes','exact_pdf_sha256','exact_pdf_size_bytes')
  ) THEN
    RAISE EXCEPTION 'FINANCE_GED_ARCHIVE_TARGET_ALREADY_EXISTS';
  END IF;
END $$;

ALTER TABLE public.authoritative_pdf_archives
  ADD COLUMN exact_pdf_bytes bytea NULL,
  ADD COLUMN exact_pdf_sha256 text NULL,
  ADD COLUMN exact_pdf_size_bytes bigint NULL;

ALTER TABLE public.authoritative_pdf_archives
  ADD CONSTRAINT authoritative_pdf_archive_exact_pdf_sha_ck
    CHECK (exact_pdf_sha256 IS NULL OR exact_pdf_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT authoritative_pdf_archive_exact_pdf_size_ck
    CHECK (exact_pdf_size_bytes IS NULL OR (exact_pdf_size_bytes > 0 AND exact_pdf_size_bytes <= 52428800)),
  ADD CONSTRAINT authoritative_pdf_archive_exact_pdf_digest_ck
    CHECK (exact_pdf_bytes IS NULL OR exact_pdf_sha256 = encode(digest(exact_pdf_bytes, 'sha256'), 'hex')),
  ADD CONSTRAINT authoritative_pdf_archive_exact_pdf_pair_ck
    CHECK (
      (exact_pdf_bytes IS NULL AND exact_pdf_sha256 IS NULL AND exact_pdf_size_bytes IS NULL)
      OR
      (exact_pdf_bytes IS NOT NULL AND exact_pdf_sha256 IS NOT NULL AND exact_pdf_size_bytes = octet_length(exact_pdf_bytes))
    );

-- Extend #612's immutable-source contract. It is intentionally not a trigger
-- replacement: existing archives retain the original guards, while legal bytes
-- cannot be swapped before or after filing.
CREATE OR REPLACE FUNCTION public.fn_authoritative_pdf_archive_immutable_612()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind OR NEW.document_version IS DISTINCT FROM OLD.document_version
     OR NEW.render_version IS DISTINCT FROM OLD.render_version OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.original_name IS DISTINCT FROM OLD.original_name
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256 OR NEW.exact_pdf_bytes IS DISTINCT FROM OLD.exact_pdf_bytes
     OR NEW.exact_pdf_sha256 IS DISTINCT FROM OLD.exact_pdf_sha256 OR NEW.exact_pdf_size_bytes IS DISTINCT FROM OLD.exact_pdf_size_bytes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_ARCHIVE_IMMUTABLE: archive source identity cannot change (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL AND (
       NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 OR NEW.pdf_size_bytes IS DISTINCT FROM OLD.pdf_size_bytes
       OR NEW.ged_document_id IS DISTINCT FROM OLD.ged_document_id OR NEW.ged_version_id IS DISTINCT FROM OLD.ged_version_id
       OR NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_ARCHIVE_IMMUTABLE: archived bytes cannot change (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON COLUMN public.authoritative_pdf_archives.exact_pdf_bytes IS
  'Durable byte-exact source for legally issued finance PDFs; GED retry must never re-render it.';

COMMIT;
