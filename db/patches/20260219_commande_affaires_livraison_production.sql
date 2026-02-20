-- 20260219_commande_affaires_livraison_production.sql
--
-- Purpose
-- - Introduce explicit LIVRAISON vs PRODUCTION semantics for client orders -> affaires
--   without changing existing affaire.type_affaire CHECK (fabrication|previsionnel|regroupement).
-- - Persist per-commande line allocation (reserved from stock / to produce) for UI indicators and auditability.
--
-- Safety
-- - Idempotent patch: safe to run multiple times.
-- - Additive / backward-compatible: no DROP of existing business data.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Role on commande_to_affaire (LIVRAISON / PRODUCTION)                     */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.commande_to_affaire
  ADD COLUMN IF NOT EXISTS role TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_to_affaire_role_check'
      AND conrelid = 'public.commande_to_affaire'::regclass
  ) THEN
    ALTER TABLE public.commande_to_affaire
      ADD CONSTRAINT commande_to_affaire_role_check
      CHECK (role IS NULL OR role IN ('LIVRAISON', 'PRODUCTION'));
  END IF;
END $$;

-- Backfill legacy rows: pick ONE mapping per commande and mark it as LIVRAISON.
-- Uses (date_conversion, id) ordering as it exists in the current schema.
WITH latest AS (
  SELECT DISTINCT ON (commande_id) id
  FROM public.commande_to_affaire
  WHERE role IS NULL
  ORDER BY commande_id, date_conversion DESC NULLS LAST, id DESC
)
UPDATE public.commande_to_affaire cta
SET role = 'LIVRAISON'
FROM latest
WHERE cta.id = latest.id;

-- Prevent duplicates per commande/role while keeping legacy rows nullable.
CREATE UNIQUE INDEX IF NOT EXISTS commande_to_affaire_commande_role_uniq
  ON public.commande_to_affaire (commande_id, role)
  WHERE role IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_to_affaire_role_idx
  ON public.commande_to_affaire (role)
  WHERE role IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 2) Commande line allocation (reserved vs to-produce)                        */
/*    NOTE: article FK column must match public.articles(id) type              */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_ligne_affaire_allocation (
  id BIGSERIAL PRIMARY KEY,

  commande_id BIGINT NOT NULL,
  commande_ligne_id BIGINT NOT NULL,

  livraison_affaire_id BIGINT NOT NULL,
  production_affaire_id BIGINT NULL,

  -- Prefer UUID reference (matches public.articles(id) when it is uuid)
  article_ref_id UUID NULL,
  -- Optional legacy numeric id (keeps backward compatibility if some envs use bigint)
  article_legacy_id BIGINT NULL,

  qty_ordered NUMERIC(18, 3) NOT NULL,
  qty_from_stock NUMERIC(18, 3) NOT NULL DEFAULT 0,
  qty_reserved NUMERIC(18, 3) NOT NULL DEFAULT 0,
  qty_to_produce NUMERIC(18, 3) NOT NULL DEFAULT 0,

  allocation_mode TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commande_ligne_affaire_allocation_qty_ordered_chk CHECK (qty_ordered > 0),
  CONSTRAINT commande_ligne_affaire_allocation_qty_nonneg_chk CHECK (
    qty_from_stock >= 0 AND qty_reserved >= 0 AND qty_to_produce >= 0
  ),
  CONSTRAINT commande_ligne_affaire_allocation_from_stock_le_ordered_chk CHECK (qty_from_stock <= qty_ordered),
  CONSTRAINT commande_ligne_affaire_allocation_reserved_le_from_stock_chk CHECK (qty_reserved <= qty_from_stock)
);

-- If the table already existed from a previous attempt, ensure new columns exist.
ALTER TABLE public.commande_ligne_affaire_allocation
  ADD COLUMN IF NOT EXISTS article_ref_id UUID NULL;

ALTER TABLE public.commande_ligne_affaire_allocation
  ADD COLUMN IF NOT EXISTS article_legacy_id BIGINT NULL;

-- Foreign keys (best-effort: keep patch runnable even if module tables differ)
DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_commande_id_fkey'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_commande_id_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.commande_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_commande_ligne_id_fkey'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_commande_ligne_id_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.affaire') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_livraison_affaire_id_fkey'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_livraison_affaire_id_fkey
      FOREIGN KEY (livraison_affaire_id) REFERENCES public.affaire(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.affaire') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_production_affaire_id_fkey'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_production_affaire_id_fkey
      FOREIGN KEY (production_affaire_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_article_ref_id_fkey'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_article_ref_id_fkey
      FOREIGN KEY (article_ref_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  -- updated_at trigger (only if shared function exists)
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS commande_ligne_affaire_allocation_set_updated_at ON public.commande_ligne_affaire_allocation';
    EXECUTE 'CREATE TRIGGER commande_ligne_affaire_allocation_set_updated_at BEFORE UPDATE ON public.commande_ligne_affaire_allocation FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

-- Determinism + integrity
CREATE UNIQUE INDEX IF NOT EXISTS commande_ligne_affaire_allocation_uniq
  ON public.commande_ligne_affaire_allocation (commande_ligne_id, livraison_affaire_id);

CREATE INDEX IF NOT EXISTS commande_ligne_affaire_allocation_commande_idx
  ON public.commande_ligne_affaire_allocation (commande_id);

CREATE INDEX IF NOT EXISTS commande_ligne_affaire_allocation_livraison_idx
  ON public.commande_ligne_affaire_allocation (livraison_affaire_id);

CREATE INDEX IF NOT EXISTS commande_ligne_affaire_allocation_production_idx
  ON public.commande_ligne_affaire_allocation (production_affaire_id)
  WHERE production_affaire_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_affaire_allocation_article_ref_idx
  ON public.commande_ligne_affaire_allocation (article_ref_id)
  WHERE article_ref_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_affaire_allocation_article_legacy_idx
  ON public.commande_ligne_affaire_allocation (article_legacy_id)
  WHERE article_legacy_id IS NOT NULL;

COMMIT;

-- DOWN (manual)
-- NOTE: The backend repo does not use an automated migration framework.
-- If you need to rollback manually, you can run (in the right order):
--   DROP TABLE IF EXISTS public.commande_ligne_affaire_allocation;
--   DROP INDEX IF EXISTS public.commande_to_affaire_commande_role_uniq;
--   ALTER TABLE public.commande_to_affaire DROP CONSTRAINT IF EXISTS commande_to_affaire_role_check;
--   ALTER TABLE public.commande_to_affaire DROP COLUMN IF EXISTS role;
