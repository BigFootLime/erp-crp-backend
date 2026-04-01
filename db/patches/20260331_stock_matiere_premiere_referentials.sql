-- Stock Matiere Premiere referentials (nuances, etats, sous-etats) + MP dimensional columns.
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Referentials: nuances / etats / sous-etats                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.stock_nuances (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  designation TEXT NOT NULL,
  densite NUMERIC(12,6) NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_code_uniq
  ON public.stock_nuances (code);

CREATE TABLE IF NOT EXISTS public.stock_etats (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  designation TEXT NOT NULL,
  unite_achat INTEGER NOT NULL DEFAULT 3020,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_etats_code_uniq
  ON public.stock_etats (code);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_etats_unite_achat_check'
      AND conrelid = 'public.stock_etats'::regclass
  ) THEN
    ALTER TABLE public.stock_etats
      ADD CONSTRAINT stock_etats_unite_achat_check
      CHECK (unite_achat > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_sous_etats (
  id BIGSERIAL PRIMARY KEY,
  etat_id BIGINT NOT NULL,
  code TEXT NOT NULL,
  designation TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_sous_etats_etat_code_uniq
  ON public.stock_sous_etats (etat_id, code);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_sous_etats_etat_id_fkey'
      AND conrelid = 'public.stock_sous_etats'::regclass
  ) THEN
    ALTER TABLE public.stock_sous_etats
      ADD CONSTRAINT stock_sous_etats_etat_id_fkey
      FOREIGN KEY (etat_id) REFERENCES public.stock_etats(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_nuance_etats (
  nuance_id BIGINT NOT NULL,
  etat_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nuance_id, etat_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_nuance_etats_nuance_id_fkey'
      AND conrelid = 'public.stock_nuance_etats'::regclass
  ) THEN
    ALTER TABLE public.stock_nuance_etats
      ADD CONSTRAINT stock_nuance_etats_nuance_id_fkey
      FOREIGN KEY (nuance_id) REFERENCES public.stock_nuances(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_nuance_etats_etat_id_fkey'
      AND conrelid = 'public.stock_nuance_etats'::regclass
  ) THEN
    ALTER TABLE public.stock_nuance_etats
      ADD CONSTRAINT stock_nuance_etats_etat_id_fkey
      FOREIGN KEY (etat_id) REFERENCES public.stock_etats(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_nuance_etats_nuance_id_idx
  ON public.stock_nuance_etats (nuance_id);

CREATE INDEX IF NOT EXISTS stock_nuance_etats_etat_id_idx
  ON public.stock_nuance_etats (etat_id);

/* -------------------------------------------------------------------------- */
/* 2) Articles Matiere: dimensional payload                                    */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.articles_matiere
  ADD COLUMN IF NOT EXISTS nuance_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS etat_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS sous_etat_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS barre_a_decouper BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS longueur_mm INTEGER NULL,
  ADD COLUMN IF NOT EXISTS longueur_unitaire_mm INTEGER NULL,
  ADD COLUMN IF NOT EXISTS largeur_mm INTEGER NULL,
  ADD COLUMN IF NOT EXISTS hauteur_mm INTEGER NULL,
  ADD COLUMN IF NOT EXISTS epaisseur_mm INTEGER NULL,
  ADD COLUMN IF NOT EXISTS diametre_mm INTEGER NULL,
  ADD COLUMN IF NOT EXISTS largeur_plat_mm INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_nuance_id_fkey'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_nuance_id_fkey
      FOREIGN KEY (nuance_id) REFERENCES public.stock_nuances(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_etat_id_fkey'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_etat_id_fkey
      FOREIGN KEY (etat_id) REFERENCES public.stock_etats(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_sous_etat_id_fkey'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_sous_etat_id_fkey
      FOREIGN KEY (sous_etat_id) REFERENCES public.stock_sous_etats(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS articles_matiere_nuance_id_idx
  ON public.articles_matiere (nuance_id)
  WHERE nuance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS articles_matiere_etat_id_idx
  ON public.articles_matiere (etat_id)
  WHERE etat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS articles_matiere_sous_etat_id_idx
  ON public.articles_matiere (sous_etat_id)
  WHERE sous_etat_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_dims_positive_check'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_dims_positive_check
      CHECK (
        (longueur_mm IS NULL OR longueur_mm > 0)
        AND (longueur_unitaire_mm IS NULL OR longueur_unitaire_mm > 0)
        AND (largeur_mm IS NULL OR largeur_mm > 0)
        AND (hauteur_mm IS NULL OR hauteur_mm > 0)
        AND (epaisseur_mm IS NULL OR epaisseur_mm > 0)
        AND (diametre_mm IS NULL OR diametre_mm > 0)
        AND (largeur_plat_mm IS NULL OR largeur_plat_mm > 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_matiere_barre_length_exclusive_check'
      AND conrelid = 'public.articles_matiere'::regclass
  ) THEN
    ALTER TABLE public.articles_matiere
      ADD CONSTRAINT articles_matiere_barre_length_exclusive_check
      CHECK (
        (barre_a_decouper = true AND longueur_mm IS NULL AND longueur_unitaire_mm IS NOT NULL)
        OR
        (barre_a_decouper = false AND longueur_unitaire_mm IS NULL)
      );
  END IF;
END $$;

COMMIT;
