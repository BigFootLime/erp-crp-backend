BEGIN;

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS creation_flow_version smallint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_creation_flow_version_chk'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_creation_flow_version_chk
      CHECK (creation_flow_version IN (1, 2));
  END IF;
END $$;

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS piece_technique_version_id uuid NULL,
  ADD COLUMN IF NOT EXISTS source_devis_ligne_id bigint NULL,
  ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS reconciliation_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reconciliation_decisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reconciliation_resolved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reconciliation_resolved_by bigint NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_piece_version_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_piece_version_fkey
      FOREIGN KEY (piece_technique_version_id)
      REFERENCES public.piece_technique_versions(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_source_devis_ligne_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_source_devis_ligne_fkey
      FOREIGN KEY (source_devis_ligne_id)
      REFERENCES public.devis_ligne(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_reconciliation_status_chk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_reconciliation_status_chk
      CHECK (reconciliation_status IN ('LEGACY', 'PENDING', 'RESOLVED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_reconciliation_sources_object_chk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_reconciliation_sources_object_chk
      CHECK (jsonb_typeof(reconciliation_sources) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_reconciliation_decisions_object_chk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_reconciliation_decisions_object_chk
      CHECK (jsonb_typeof(reconciliation_decisions) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_ligne_piece_version_idx
  ON public.commande_ligne (piece_technique_version_id, article_id)
  WHERE piece_technique_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_source_devis_line_idx
  ON public.commande_ligne (source_devis_ligne_id)
  WHERE source_devis_ligne_id IS NOT NULL;

COMMIT;

