-- Demo schema compatibility guardrails.
-- Additive/idempotent patch for legacy databases where timestamp columns
-- expected by devis -> commande client flows were never added.

BEGIN;

ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE public.devis
SET created_at = COALESCE(created_at, date_creation::timestamptz, now())
WHERE created_at IS NULL;

UPDATE public.devis
SET updated_at = COALESCE(updated_at, created_at, date_creation::timestamptz, now())
WHERE updated_at IS NULL;

ALTER TABLE public.devis
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.articles') IS NOT NULL THEN
    ALTER TABLE public.articles
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    UPDATE public.articles
    SET created_at = COALESCE(created_at, updated_at, now())
    WHERE created_at IS NULL;

    UPDATE public.articles
    SET updated_at = COALESCE(updated_at, created_at, now())
    WHERE updated_at IS NULL;

    ALTER TABLE public.articles
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET DEFAULT now();
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL THEN
    ALTER TABLE public.pieces_techniques
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    UPDATE public.pieces_techniques
    SET created_at = COALESCE(created_at, updated_at, now())
    WHERE created_at IS NULL;

    UPDATE public.pieces_techniques
    SET updated_at = COALESCE(updated_at, created_at, now())
    WHERE updated_at IS NULL;

    ALTER TABLE public.pieces_techniques
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET DEFAULT now();
  END IF;

  IF to_regclass('public.article_devis') IS NOT NULL THEN
    ALTER TABLE public.article_devis
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    UPDATE public.article_devis
    SET created_at = COALESCE(created_at, updated_at, now())
    WHERE created_at IS NULL;

    UPDATE public.article_devis
    SET updated_at = COALESCE(updated_at, created_at, now())
    WHERE updated_at IS NULL;

    ALTER TABLE public.article_devis
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET DEFAULT now();
  END IF;

  IF to_regclass('public.dossier_technique_piece_devis') IS NOT NULL THEN
    ALTER TABLE public.dossier_technique_piece_devis
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    UPDATE public.dossier_technique_piece_devis
    SET created_at = COALESCE(created_at, updated_at, now())
    WHERE created_at IS NULL;

    UPDATE public.dossier_technique_piece_devis
    SET updated_at = COALESCE(updated_at, created_at, now())
    WHERE updated_at IS NULL;

    ALTER TABLE public.dossier_technique_piece_devis
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET DEFAULT now();
  END IF;

  IF to_regclass('public.article_devis_promotion') IS NOT NULL THEN
    ALTER TABLE public.article_devis_promotion
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    UPDATE public.article_devis_promotion
    SET created_at = COALESCE(created_at, promoted_at, updated_at, now())
    WHERE created_at IS NULL;

    UPDATE public.article_devis_promotion
    SET updated_at = COALESCE(updated_at, promoted_at, created_at, now())
    WHERE updated_at IS NULL;

    ALTER TABLE public.article_devis_promotion
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET DEFAULT now();
  END IF;

  IF to_regclass('public.dossier_technique_piece_devis_promotion') IS NOT NULL THEN
    ALTER TABLE public.dossier_technique_piece_devis_promotion
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

    UPDATE public.dossier_technique_piece_devis_promotion
    SET created_at = COALESCE(created_at, promoted_at, updated_at, now())
    WHERE created_at IS NULL;

    UPDATE public.dossier_technique_piece_devis_promotion
    SET updated_at = COALESCE(updated_at, promoted_at, created_at, now())
    WHERE updated_at IS NULL;

    ALTER TABLE public.dossier_technique_piece_devis_promotion
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET DEFAULT now();
  END IF;
END $$;

COMMIT;
