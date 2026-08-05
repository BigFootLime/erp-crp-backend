-- Disposable syntax/invariant harness only. Never apply outside a fresh cerp_test.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE cerp_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.users (id integer PRIMARY KEY);
CREATE TABLE public.quality_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.quality_release_decision (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.bon_livraison_pack_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'GENERATED',
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by integer NULL,
  bl_pdf_document_id uuid NULL,
  cofc_pdf_document_id uuid NULL,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum_sha256 text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);
