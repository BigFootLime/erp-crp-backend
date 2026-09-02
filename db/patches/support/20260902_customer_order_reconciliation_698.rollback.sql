DO $$
BEGIN
  IF current_database() !~* 'test' THEN
    RAISE EXCEPTION 'Patch #698 rollback is restricted to a test database';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commande_client WHERE creation_flow_version = 2)
     OR EXISTS (
       SELECT 1 FROM public.commande_ligne
       WHERE piece_technique_version_id IS NOT NULL
          OR source_devis_ligne_id IS NOT NULL
          OR reconciliation_status <> 'LEGACY'
          OR reconciliation_sources <> '{}'::jsonb
          OR reconciliation_decisions <> '{}'::jsonb
     ) THEN
    RAISE EXCEPTION 'Patch #698 is already used and cannot be rolled back safely';
  END IF;
END $$;

DROP INDEX IF EXISTS public.commande_ligne_source_devis_line_idx;
DROP INDEX IF EXISTS public.commande_ligne_piece_version_idx;

ALTER TABLE public.commande_ligne
  DROP CONSTRAINT IF EXISTS commande_ligne_reconciliation_decisions_object_chk,
  DROP CONSTRAINT IF EXISTS commande_ligne_reconciliation_sources_object_chk,
  DROP CONSTRAINT IF EXISTS commande_ligne_reconciliation_status_chk,
  DROP CONSTRAINT IF EXISTS commande_ligne_source_devis_ligne_fkey,
  DROP CONSTRAINT IF EXISTS commande_ligne_piece_version_fkey,
  DROP COLUMN IF EXISTS reconciliation_resolved_by,
  DROP COLUMN IF EXISTS reconciliation_resolved_at,
  DROP COLUMN IF EXISTS reconciliation_decisions,
  DROP COLUMN IF EXISTS reconciliation_sources,
  DROP COLUMN IF EXISTS reconciliation_status,
  DROP COLUMN IF EXISTS source_devis_ligne_id,
  DROP COLUMN IF EXISTS piece_technique_version_id;

ALTER TABLE public.commande_client
  DROP CONSTRAINT IF EXISTS commande_client_creation_flow_version_chk,
  DROP COLUMN IF EXISTS creation_flow_version;
