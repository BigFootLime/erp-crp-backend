-- #625 rollback — test-rehearsal only and refused once a legal source exists.
\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database() <> 'cerp_test' OR current_setting('cerp.migration_rehearsal', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION '#625 rollback is test-only: cerp_test and cerp.migration_rehearsal=on required';
  END IF;
END $guard$;

BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.authoritative_pdf_archives
     WHERE exact_pdf_bytes IS NOT NULL OR exact_pdf_sha256 IS NOT NULL OR exact_pdf_size_bytes IS NOT NULL
  ) THEN
    RAISE EXCEPTION '#625 rollback refused: issued legal finance PDF source exists.';
  END IF;
END $$;

ALTER TABLE public.authoritative_pdf_archives
  DROP CONSTRAINT IF EXISTS authoritative_pdf_archive_exact_pdf_pair_ck,
  DROP CONSTRAINT IF EXISTS authoritative_pdf_archive_exact_pdf_digest_ck,
  DROP CONSTRAINT IF EXISTS authoritative_pdf_archive_exact_pdf_size_ck,
  DROP CONSTRAINT IF EXISTS authoritative_pdf_archive_exact_pdf_sha_ck,
  DROP COLUMN IF EXISTS exact_pdf_size_bytes,
  DROP COLUMN IF EXISTS exact_pdf_sha256,
  DROP COLUMN IF EXISTS exact_pdf_bytes;

-- Restore #612's trigger body too.  The function body is PL/pgSQL (so its
-- record-field references are not a catalog dependency) and would otherwise
-- fail at the next archive UPDATE after the columns above disappear.
CREATE OR REPLACE FUNCTION public.fn_authoritative_pdf_archive_immutable_612()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
     OR NEW.document_version IS DISTINCT FROM OLD.document_version
     OR NEW.render_version IS DISTINCT FROM OLD.render_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.original_name IS DISTINCT FROM OLD.original_name
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_ARCHIVE_IMMUTABLE: archive source identity cannot change (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL AND (
       NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
       OR NEW.pdf_size_bytes IS DISTINCT FROM OLD.pdf_size_bytes
       OR NEW.ged_document_id IS DISTINCT FROM OLD.ged_document_id
       OR NEW.ged_version_id IS DISTINCT FROM OLD.ged_version_id
       OR NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'AUTHORITATIVE_PDF_ARCHIVE_IMMUTABLE: archived bytes cannot change (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
