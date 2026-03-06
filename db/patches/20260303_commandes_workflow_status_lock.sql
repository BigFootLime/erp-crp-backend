-- 20260303_commandes_workflow_status_lock.sql
--
-- Purpose
-- - Support Commande workflow statuses (ENREGISTREE -> PLANIFIEE -> PLANIFIEE_PRET_AR -> AR_ENVOYEE)
--   with DB fields for key milestones (planning validation, AR sent).
-- - Add an index to efficiently read the latest commande status from commande_historique.
--
-- Safety
-- - Idempotent patch: safe to run multiple times.
-- - Additive only: ALTER/CREATE only.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Workflow milestone fields on commande_client                              */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS planning_validated_at TIMESTAMPTZ NULL;

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS planning_validated_by INTEGER NULL;

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS ar_sent_at TIMESTAMPTZ NULL;

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS ar_sent_by INTEGER NULL;

CREATE INDEX IF NOT EXISTS commande_client_planning_validated_at_idx
  ON public.commande_client (planning_validated_at)
  WHERE planning_validated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_client_ar_sent_at_idx
  ON public.commande_client (ar_sent_at)
  WHERE ar_sent_at IS NOT NULL;

DO $$
BEGIN
  -- FK constraints (best-effort)
  IF to_regclass('public.users') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'commande_client_planning_validated_by_fkey'
        AND conrelid = 'public.commande_client'::regclass
    ) THEN
      ALTER TABLE public.commande_client
        ADD CONSTRAINT commande_client_planning_validated_by_fkey
        FOREIGN KEY (planning_validated_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'commande_client_ar_sent_by_fkey'
        AND conrelid = 'public.commande_client'::regclass
    ) THEN
      ALTER TABLE public.commande_client
        ADD CONSTRAINT commande_client_ar_sent_by_fkey
        FOREIGN KEY (ar_sent_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Latest status lookup index on commande_historique                         */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.commande_historique') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS commande_historique_commande_last_idx ON public.commande_historique (commande_id, date_action DESC, id DESC)';
  END IF;
END $$;

COMMIT;
