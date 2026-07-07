-- 20260706_affaire_allow_projet.sql
--
-- Purpose
-- - Allow public.affaire.type_affaire = 'projet' (in addition to 'livraison').
-- - Reconciles the earlier livraison-only CHECK (20260306_livraison_only_affaires.sql)
--   with the projet feature introduced by 20260325 (nullable client_id +
--   articles.projet_id FK -> affaire.id). Without this, fabricated-article creation
--   was impossible end-to-end: an article 'fabrique' requires a projet affaire,
--   but no projet affaire could exist while the livraison-only CHECK stood.
--
-- Safety / constraints
-- - Idempotent (safe to run multiple times).
-- - Non-destructive: only swaps a CHECK constraint. No DROP of data, no column loss.
-- - Scope: ONLY public.affaire is widened. public.commande_client stays
--   livraison-only on purpose (its type_affaire is 'livraison' by design).
--
-- Target DB: PostgreSQL

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.affaire') IS NULL THEN
    RAISE NOTICE 'Skipping: public.affaire missing';
    RETURN;
  END IF;

  -- Remove the legacy livraison-only CHECK if present.
  ALTER TABLE public.affaire
    DROP CONSTRAINT IF EXISTS affaire_type_affaire_livraison_check;

  -- Keep 'livraison' as the row default; 'projet' is opt-in per row.
  EXECUTE 'ALTER TABLE public.affaire ALTER COLUMN type_affaire SET DEFAULT ''livraison''';

  -- Add the widened CHECK (livraison | projet) if not already present.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affaire_type_affaire_check'
      AND conrelid = 'public.affaire'::regclass
  ) THEN
    ALTER TABLE public.affaire
      ADD CONSTRAINT affaire_type_affaire_check
      CHECK (type_affaire IN ('livraison', 'projet'));
  END IF;
END $$;

COMMIT;
