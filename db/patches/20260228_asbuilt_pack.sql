-- 20260228_asbuilt_pack.sql
-- Phase 13A: As-built (dossier de lot) pack versions for finished-good lots
--
-- As-built pack versions for a finished-good lot.
-- pdf_document_id references public.documents_clients(id).

BEGIN;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

CREATE TABLE IF NOT EXISTS public.asbuilt_pack_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_fg_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE CASCADE,
  version int NOT NULL,
  status text NOT NULL DEFAULT 'GENERATED',
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by int NULL REFERENCES public.users(id),
  signataire_user_id int NULL REFERENCES public.users(id),
  commentaire text NULL,
  pdf_document_id uuid NULL REFERENCES public.documents_clients(id),
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by int NULL REFERENCES public.users(id),
  updated_by int NULL REFERENCES public.users(id),
  CONSTRAINT asbuilt_pack_versions_status_check CHECK (status IN ('GENERATED','REVOKED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS asbuilt_pack_versions_lot_version_uniq
  ON public.asbuilt_pack_versions (lot_fg_id, version);

CREATE INDEX IF NOT EXISTS asbuilt_pack_versions_lot_idx
  ON public.asbuilt_pack_versions (lot_fg_id);

CREATE INDEX IF NOT EXISTS asbuilt_pack_versions_generated_at_idx
  ON public.asbuilt_pack_versions (generated_at);

CREATE INDEX IF NOT EXISTS asbuilt_pack_versions_status_idx
  ON public.asbuilt_pack_versions (status);

CREATE INDEX IF NOT EXISTS asbuilt_pack_versions_pdf_document_id_idx
  ON public.asbuilt_pack_versions (pdf_document_id);

COMMIT;
