-- 20260224_livraisons_pack_versions.sql
-- Phase 6: Dossier de livraison (as-shipped pack)
-- - Persist pack generations (versioned) for audit-ready PDF outputs.
-- - Links generated BL PDF + CofC PDF documents to a BL.
--
-- Idempotent patch: safe to re-run.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.bon_livraison_pack_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id UUID NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by INTEGER NULL,
  bl_pdf_document_id UUID NULL,
  cofc_pdf_document_id UUID NULL,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  checksum_sha256 TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bon_livraison_pack_versions_bl_version_uniq
  ON public.bon_livraison_pack_versions (bon_livraison_id, version);

CREATE INDEX IF NOT EXISTS bon_livraison_pack_versions_bl_generated_at_idx
  ON public.bon_livraison_pack_versions (bon_livraison_id, generated_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_status_check'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_status_check
      CHECK (status IN ('GENERATED','REVOKED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_version_check'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_version_check
      CHECK (version > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_bl_fkey'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_bl_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_generated_by_fkey'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_generated_by_fkey
      FOREIGN KEY (generated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_created_by_fkey'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_updated_by_fkey'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_bl_pdf_document_fkey'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_bl_pdf_document_fkey
      FOREIGN KEY (bl_pdf_document_id) REFERENCES public.bon_livraison_documents(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_versions_cofc_pdf_document_fkey'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_versions_cofc_pdf_document_fkey
      FOREIGN KEY (cofc_pdf_document_id) REFERENCES public.bon_livraison_documents(id) ON DELETE SET NULL;
  END IF;

  -- updated_at trigger (best effort)
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS bon_livraison_pack_versions_set_updated_at ON public.bon_livraison_pack_versions';
    EXECUTE 'CREATE TRIGGER bon_livraison_pack_versions_set_updated_at BEFORE UPDATE ON public.bon_livraison_pack_versions FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

-- Verification queries (manual):
-- 1) Table exists:
--    SELECT to_regclass('public.bon_livraison_pack_versions');
-- 2) Constraints:
--    SELECT conname FROM pg_constraint WHERE conrelid='public.bon_livraison_pack_versions'::regclass;
-- 3) Versions (replace :bl_id):
--    SELECT bon_livraison_id, version, status, generated_at, bl_pdf_document_id, cofc_pdf_document_id
--    FROM public.bon_livraison_pack_versions
--    WHERE bon_livraison_id = :bl_id::uuid
--    ORDER BY version DESC;

COMMIT;
