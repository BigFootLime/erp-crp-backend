-- 20260228_traceability_links.sql
-- Phase 13A: Generic traceability spine (polymorphic link table)
--
-- Generic link table used to build cross-module traceability graphs.
-- Note: ids are stored as text to support both numeric (e.g. devis/commande/of)
-- and uuid identifiers (e.g. lots, bon_livraison).

BEGIN;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

CREATE TABLE IF NOT EXISTS public.traceability_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  source_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  link_type text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by int NULL REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS traceability_links_source_idx
  ON public.traceability_links (source_type, source_id);

CREATE INDEX IF NOT EXISTS traceability_links_target_idx
  ON public.traceability_links (target_type, target_id);

CREATE INDEX IF NOT EXISTS traceability_links_link_type_idx
  ON public.traceability_links (link_type);

CREATE UNIQUE INDEX IF NOT EXISTS traceability_links_uniq
  ON public.traceability_links (source_type, source_id, target_type, target_id, link_type);

COMMIT;
