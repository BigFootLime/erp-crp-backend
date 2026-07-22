-- 20260722_devis_workflow_167.sql
--
-- Purpose (#167 — workflow Devis, préparation → conversion contrôlée)
-- - devis_ligne.position : ordre métier des lignes persisté (1-based), backfill par id.
-- - devis_idempotence   : rejeu idempotent des actions CREATE / REVISE / CONVERT
--   (clé -> action + empreinte SHA-256 du payload + résultat JSON rejouable).
--
-- Safety
-- - Idempotent (safe to run multiple times) ; additif uniquement, aucune suppression.
-- - Backfill de position uniquement là où position IS NULL (ordre historique = id ASC).
-- - Aucune écriture hors public.devis_ligne / public.devis_idempotence.
--
-- Target DB: PostgreSQL (cerp_test d'abord ; cerp_prod uniquement après validation humaine)

BEGIN;

-- 1) Ordre métier des lignes de devis.
DO $$
BEGIN
  IF to_regclass('public.devis_ligne') IS NULL THEN
    RAISE NOTICE 'Skipping: public.devis_ligne missing';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'devis_ligne' AND column_name = 'position'
  ) THEN
    ALTER TABLE public.devis_ligne ADD COLUMN position integer;
  END IF;

  -- Backfill : l'ordre historique observable (id croissant) devient la position persistée.
  UPDATE public.devis_ligne dl
  SET position = numbered.rn
  FROM (
    SELECT id, row_number() OVER (PARTITION BY devis_id ORDER BY id ASC) AS rn
    FROM public.devis_ligne
  ) AS numbered
  WHERE dl.id = numbered.id
    AND dl.position IS NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devis_ligne_position_positive' AND conrelid = 'public.devis_ligne'::regclass
  ) THEN
    ALTER TABLE public.devis_ligne
      ADD CONSTRAINT devis_ligne_position_positive
      CHECK (position IS NULL OR position > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS devis_ligne_devis_position_idx
  ON public.devis_ligne (devis_id, position);

-- 2) Idempotence des écritures devis (pattern #172 commande_fournisseur_idempotence,
--    enrichi d'une empreinte de payload : même clé + payload différent -> 409).
DO $$
BEGIN
  IF to_regclass('public.devis') IS NULL THEN
    RAISE NOTICE 'Skipping: public.devis missing';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.devis_idempotence (
    cle          text PRIMARY KEY,
    action       text NOT NULL CHECK (action IN ('CREATE', 'REVISE', 'CONVERT')),
    devis_id     bigint NULL REFERENCES public.devis (id) ON DELETE SET NULL,
    payload_hash text NOT NULL,
    resultat     jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  );
END $$;

CREATE INDEX IF NOT EXISTS devis_idempotence_devis_id_idx
  ON public.devis_idempotence (devis_id)
  WHERE devis_id IS NOT NULL;

COMMIT;
