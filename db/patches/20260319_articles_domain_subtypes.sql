BEGIN;

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS family_code TEXT;

UPDATE public.articles
SET article_category = CASE article_category
  WHEN 'PIECE_TECHNIQUE' THEN 'fabrique'
  WHEN 'MATIERE_PREMIERE' THEN 'matiere'
  WHEN 'TRAITEMENT' THEN 'traitement'
  WHEN 'FOURNITURE' THEN 'achat'
  ELSE COALESCE(NULLIF(btrim(article_category), ''), 'achat')
END;

UPDATE public.articles a
SET family_code = COALESCE(
  NULLIF(btrim(pf.code), ''),
  CASE a.article_category
    WHEN 'fabrique' THEN 'PT'
    WHEN 'matiere' THEN 'MAT'
    WHEN 'traitement' THEN 'TRT'
    ELSE 'ACH'
  END
)
FROM public.pieces_techniques pt
LEFT JOIN public.pieces_families pf ON pf.id = pt.famille_id
WHERE a.family_code IS NULL
  AND a.article_category = 'fabrique'
  AND a.piece_technique_id = pt.id;

UPDATE public.articles
SET family_code = CASE article_category
  WHEN 'fabrique' THEN 'PT'
  WHEN 'matiere' THEN 'MAT'
  WHEN 'traitement' THEN 'TRT'
  ELSE 'ACH'
END
WHERE family_code IS NULL OR btrim(family_code) = '';

ALTER TABLE public.articles
  ALTER COLUMN family_code SET NOT NULL;

ALTER TABLE public.articles
  ALTER COLUMN article_category SET NOT NULL;

ALTER TABLE public.articles
  DROP CONSTRAINT IF EXISTS articles_article_category_check;

ALTER TABLE public.articles
  ADD CONSTRAINT articles_article_category_check
  CHECK (article_category IN ('fabrique','matiere','traitement','achat'));

ALTER TABLE public.articles
  DROP CONSTRAINT IF EXISTS articles_piece_type_consistency_check;

ALTER TABLE public.articles
  ADD CONSTRAINT articles_piece_type_consistency_check
  CHECK (
    (article_category = 'fabrique' AND piece_technique_id IS NOT NULL AND article_type = 'PIECE_TECHNIQUE')
    OR
    (article_category IN ('matiere','traitement','achat') AND article_type = 'PURCHASED')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_family_code_not_blank_check'
      AND conrelid = 'public.articles'::regclass
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_family_code_not_blank_check
      CHECK (btrim(family_code) <> '');
  END IF;
END $$;

DROP INDEX IF EXISTS articles_piece_technique_id_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS articles_piece_technique_id_uniq
  ON public.articles (piece_technique_id)
  WHERE piece_technique_id IS NOT NULL AND article_category = 'fabrique';

CREATE INDEX IF NOT EXISTS articles_family_code_idx ON public.articles (family_code);
CREATE INDEX IF NOT EXISTS articles_code_search_idx ON public.articles (lower(code));
CREATE INDEX IF NOT EXISTS pieces_techniques_code_piece_search_idx ON public.pieces_techniques (lower(code_piece));

CREATE TABLE IF NOT EXISTS public.articles_fabrique_families (
  code TEXT PRIMARY KEY,
  designation TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.articles_matiere_families (
  code TEXT PRIMARY KEY,
  designation TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.articles_traitement_families (
  code TEXT PRIMARY KEY,
  designation TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.articles_achat_families (
  code TEXT PRIMARY KEY,
  designation TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.articles_fabrique (
  article_id UUID PRIMARY KEY,
  family_code TEXT NOT NULL,
  piece_technique_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT articles_fabrique_article_fk FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE,
  CONSTRAINT articles_fabrique_family_fk FOREIGN KEY (family_code) REFERENCES public.articles_fabrique_families(code) ON DELETE RESTRICT,
  CONSTRAINT articles_fabrique_piece_fk FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS articles_fabrique_piece_uniq ON public.articles_fabrique (piece_technique_id);

CREATE TABLE IF NOT EXISTS public.articles_matiere (
  article_id UUID PRIMARY KEY,
  family_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT articles_matiere_article_fk FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE,
  CONSTRAINT articles_matiere_family_fk FOREIGN KEY (family_code) REFERENCES public.articles_matiere_families(code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.articles_traitement (
  article_id UUID PRIMARY KEY,
  family_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT articles_traitement_article_fk FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE,
  CONSTRAINT articles_traitement_family_fk FOREIGN KEY (family_code) REFERENCES public.articles_traitement_families(code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.articles_achat (
  article_id UUID PRIMARY KEY,
  family_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT articles_achat_article_fk FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE,
  CONSTRAINT articles_achat_family_fk FOREIGN KEY (family_code) REFERENCES public.articles_achat_families(code) ON DELETE RESTRICT
);

INSERT INTO public.articles_fabrique_families (code, designation)
SELECT DISTINCT family_code, family_code
FROM public.articles
WHERE article_category = 'fabrique'
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.articles_matiere_families (code, designation)
SELECT DISTINCT family_code, family_code
FROM public.articles
WHERE article_category = 'matiere'
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.articles_traitement_families (code, designation)
SELECT DISTINCT family_code, family_code
FROM public.articles
WHERE article_category = 'traitement'
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.articles_achat_families (code, designation)
SELECT DISTINCT family_code, family_code
FROM public.articles
WHERE article_category = 'achat'
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.articles_fabrique (article_id, family_code, piece_technique_id)
SELECT a.id, a.family_code, a.piece_technique_id
FROM public.articles a
WHERE a.article_category = 'fabrique'
  AND a.piece_technique_id IS NOT NULL
ON CONFLICT (article_id) DO UPDATE
SET family_code = EXCLUDED.family_code,
    piece_technique_id = EXCLUDED.piece_technique_id,
    updated_at = now();

INSERT INTO public.articles_matiere (article_id, family_code)
SELECT a.id, a.family_code
FROM public.articles a
WHERE a.article_category = 'matiere'
ON CONFLICT (article_id) DO UPDATE
SET family_code = EXCLUDED.family_code,
    updated_at = now();

INSERT INTO public.articles_traitement (article_id, family_code)
SELECT a.id, a.family_code
FROM public.articles a
WHERE a.article_category = 'traitement'
ON CONFLICT (article_id) DO UPDATE
SET family_code = EXCLUDED.family_code,
    updated_at = now();

INSERT INTO public.articles_achat (article_id, family_code)
SELECT a.id, a.family_code
FROM public.articles a
WHERE a.article_category = 'achat'
ON CONFLICT (article_id) DO UPDATE
SET family_code = EXCLUDED.family_code,
    updated_at = now();

DELETE FROM public.articles_fabrique WHERE article_id IN (SELECT id FROM public.articles WHERE article_category <> 'fabrique');
DELETE FROM public.articles_matiere WHERE article_id IN (SELECT id FROM public.articles WHERE article_category <> 'matiere');
DELETE FROM public.articles_traitement WHERE article_id IN (SELECT id FROM public.articles WHERE article_category <> 'traitement');
DELETE FROM public.articles_achat WHERE article_id IN (SELECT id FROM public.articles WHERE article_category <> 'achat');

DO $$
BEGIN
  IF to_regclass('public.commande_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_article_fabrique_fk'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_article_fabrique_fk
      FOREIGN KEY (article_id) REFERENCES public.articles_fabrique(article_id) NOT VALID;
  END IF;

  IF to_regclass('public.commande_cadre_release_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_article_fabrique_fk'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_article_fabrique_fk
      FOREIGN KEY (article_id) REFERENCES public.articles_fabrique(article_id) NOT VALID;
  END IF;

  IF to_regclass('public.ordres_fabrication') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_article_fabrique_fk'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_article_fabrique_fk
      FOREIGN KEY (article_id) REFERENCES public.articles_fabrique(article_id) NOT VALID;
  END IF;
END $$;

COMMIT;
