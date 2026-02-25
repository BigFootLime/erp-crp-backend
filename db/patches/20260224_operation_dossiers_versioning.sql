-- 20260224_operation_dossiers_versioning.sql
-- Dossier technique versionne par operation (gamme / OF)
-- - Operation dossiers headers (one per operation per dossier type)
-- - Immutable versions timeline
-- - Slot-based documents per version (copy-forward UX)
--
-- Idempotent patch: safe to re-run.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* -------------------------------------------------------------------------- */
/* 1) Dossier headers                                                         */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.operation_dossiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  dossier_type TEXT NOT NULL,
  title TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_dossiers_operation_uniq
  ON public.operation_dossiers (operation_type, operation_id, dossier_type);

/* -------------------------------------------------------------------------- */
/* 2) Versions (immutable)                                                    */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.operation_dossier_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL,
  version INTEGER NOT NULL,
  commentaire TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_dossier_versions_dossier_version_uniq
  ON public.operation_dossier_versions (dossier_id, version);

CREATE INDEX IF NOT EXISTS operation_dossier_versions_dossier_created_at_idx
  ON public.operation_dossier_versions (dossier_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* 3) Version documents (slots)                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.operation_dossier_version_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_version_id UUID NOT NULL,
  slot_key TEXT NOT NULL,
  label TEXT NULL,
  commentaire TEXT NULL,
  document_id UUID NULL,
  mime_type TEXT NULL,
  file_name TEXT NULL,
  file_size_bytes BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_dossier_version_documents_slot_uniq
  ON public.operation_dossier_version_documents (dossier_version_id, slot_key);

CREATE INDEX IF NOT EXISTS operation_dossier_version_documents_dossier_version_idx
  ON public.operation_dossier_version_documents (dossier_version_id);

CREATE INDEX IF NOT EXISTS operation_dossier_version_documents_document_id_idx
  ON public.operation_dossier_version_documents (document_id);

/* -------------------------------------------------------------------------- */
/* Constraints + foreign keys (added best-effort, idempotent)                 */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  /* operation_dossiers */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossiers_operation_type_check'
      AND conrelid = 'public.operation_dossiers'::regclass
  ) THEN
    ALTER TABLE public.operation_dossiers
      ADD CONSTRAINT operation_dossiers_operation_type_check
      CHECK (operation_type IN ('PIECE_TECHNIQUE_OPERATION','OF_OPERATION'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossiers_dossier_type_check'
      AND conrelid = 'public.operation_dossiers'::regclass
  ) THEN
    ALTER TABLE public.operation_dossiers
      ADD CONSTRAINT operation_dossiers_dossier_type_check
      CHECK (dossier_type IN ('TECHNIQUE','PROGRAMMATION'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossiers_operation_id_not_blank'
      AND conrelid = 'public.operation_dossiers'::regclass
  ) THEN
    ALTER TABLE public.operation_dossiers
      ADD CONSTRAINT operation_dossiers_operation_id_not_blank
      CHECK (length(trim(operation_id)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossiers_created_by_fkey'
      AND conrelid = 'public.operation_dossiers'::regclass
  ) THEN
    ALTER TABLE public.operation_dossiers
      ADD CONSTRAINT operation_dossiers_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossiers_updated_by_fkey'
      AND conrelid = 'public.operation_dossiers'::regclass
  ) THEN
    ALTER TABLE public.operation_dossiers
      ADD CONSTRAINT operation_dossiers_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  /* operation_dossier_versions */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_versions_dossier_fkey'
      AND conrelid = 'public.operation_dossier_versions'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_versions
      ADD CONSTRAINT operation_dossier_versions_dossier_fkey
      FOREIGN KEY (dossier_id) REFERENCES public.operation_dossiers(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_versions_version_check'
      AND conrelid = 'public.operation_dossier_versions'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_versions
      ADD CONSTRAINT operation_dossier_versions_version_check
      CHECK (version > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_versions_created_by_fkey'
      AND conrelid = 'public.operation_dossier_versions'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_versions
      ADD CONSTRAINT operation_dossier_versions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  /* operation_dossier_version_documents */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_version_documents_version_fkey'
      AND conrelid = 'public.operation_dossier_version_documents'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_version_documents
      ADD CONSTRAINT operation_dossier_version_documents_version_fkey
      FOREIGN KEY (dossier_version_id) REFERENCES public.operation_dossier_versions(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_version_documents_document_fkey'
      AND conrelid = 'public.operation_dossier_version_documents'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_version_documents
      ADD CONSTRAINT operation_dossier_version_documents_document_fkey
      FOREIGN KEY (document_id) REFERENCES public.documents_clients(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_version_documents_created_by_fkey'
      AND conrelid = 'public.operation_dossier_version_documents'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_version_documents
      ADD CONSTRAINT operation_dossier_version_documents_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_dossier_version_documents_updated_by_fkey'
      AND conrelid = 'public.operation_dossier_version_documents'::regclass
  ) THEN
    ALTER TABLE public.operation_dossier_version_documents
      ADD CONSTRAINT operation_dossier_version_documents_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  /* updated_at trigger (best effort) */
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS operation_dossiers_set_updated_at ON public.operation_dossiers';
    EXECUTE 'CREATE TRIGGER operation_dossiers_set_updated_at BEFORE UPDATE ON public.operation_dossiers FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS operation_dossier_version_documents_set_updated_at ON public.operation_dossier_version_documents';
    EXECUTE 'CREATE TRIGGER operation_dossier_version_documents_set_updated_at BEFORE UPDATE ON public.operation_dossier_version_documents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

-- Verification queries (manual):
-- 1) Tables exist:
--    SELECT to_regclass('public.operation_dossiers');
--    SELECT to_regclass('public.operation_dossier_versions');
--    SELECT to_regclass('public.operation_dossier_version_documents');
-- 2) Constraints:
--    SELECT conname FROM pg_constraint WHERE conrelid='public.operation_dossiers'::regclass;
-- 3) Latest versions (replace vars):
--    SELECT * FROM public.operation_dossiers WHERE operation_type='PIECE_TECHNIQUE_OPERATION' AND operation_id='...';

COMMIT;
