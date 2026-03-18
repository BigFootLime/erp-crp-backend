-- Commande Client sells Article directly.
-- - Add explicit article/piece references on commande lines
-- - Preserve legacy code_piece as a readable snapshot during cutover
-- - Link OFs back to originating commande lines/articles for traceability

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) commande_ligne -> article_id / piece_technique_id                        */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS article_id UUID NULL;

ALTER TABLE public.commande_ligne
  ADD COLUMN IF NOT EXISTS piece_technique_id UUID NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_article_idx
  ON public.commande_ligne (article_id)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_ligne_piece_technique_idx
  ON public.commande_ligne (piece_technique_id)
  WHERE piece_technique_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_article_id_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_piece_technique_id_fkey'
      AND conrelid = 'public.commande_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne
      ADD CONSTRAINT commande_ligne_piece_technique_id_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;
END $$;

WITH resolved AS (
  SELECT
    cl.id AS commande_ligne_id,
    art.article_id,
    COALESCE(art.piece_technique_id, pt.piece_technique_id) AS piece_technique_id
  FROM public.commande_ligne cl
  LEFT JOIN LATERAL (
    SELECT
      a.id AS article_id,
      a.piece_technique_id
    FROM public.articles a
    LEFT JOIN public.pieces_techniques apt
      ON apt.id = a.piece_technique_id
    WHERE cl.code_piece IS NOT NULL
      AND (
        a.code = btrim(cl.code_piece)
        OR apt.code_piece = btrim(cl.code_piece)
      )
    ORDER BY
      (a.code = btrim(cl.code_piece)) DESC,
      a.updated_at DESC NULLS LAST,
      a.created_at DESC NULLS LAST,
      a.id ASC
    LIMIT 1
  ) art ON TRUE
  LEFT JOIN LATERAL (
    SELECT pt.id AS piece_technique_id
    FROM public.pieces_techniques pt
    WHERE cl.code_piece IS NOT NULL
      AND pt.code_piece = btrim(cl.code_piece)
    ORDER BY pt.updated_at DESC NULLS LAST, pt.created_at DESC NULLS LAST, pt.id ASC
    LIMIT 1
  ) pt ON TRUE
  WHERE cl.article_id IS NULL OR cl.piece_technique_id IS NULL
)
UPDATE public.commande_ligne cl
SET
  article_id = COALESCE(cl.article_id, resolved.article_id),
  piece_technique_id = COALESCE(cl.piece_technique_id, resolved.piece_technique_id)
FROM resolved
WHERE cl.id = resolved.commande_ligne_id
  AND (resolved.article_id IS NOT NULL OR resolved.piece_technique_id IS NOT NULL);

/* -------------------------------------------------------------------------- */
/* 2) CADRE release lines keep traceability when detached from commande line    */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.commande_cadre_release_ligne
  ADD COLUMN IF NOT EXISTS article_id UUID NULL;

ALTER TABLE public.commande_cadre_release_ligne
  ADD COLUMN IF NOT EXISTS piece_technique_id UUID NULL;

CREATE INDEX IF NOT EXISTS commande_cadre_release_ligne_article_idx
  ON public.commande_cadre_release_ligne (article_id)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commande_cadre_release_ligne_piece_technique_idx
  ON public.commande_cadre_release_ligne (piece_technique_id)
  WHERE piece_technique_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_article_id_fkey'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_piece_technique_id_fkey'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_piece_technique_id_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE public.commande_cadre_release_ligne rl
SET
  article_id = COALESCE(rl.article_id, cl.article_id),
  piece_technique_id = COALESCE(rl.piece_technique_id, cl.piece_technique_id)
FROM public.commande_ligne cl
WHERE rl.commande_ligne_id = cl.id
  AND (
    rl.article_id IS DISTINCT FROM cl.article_id
    OR rl.piece_technique_id IS DISTINCT FROM cl.piece_technique_id
  );

WITH resolved AS (
  SELECT
    rl.id AS release_line_id,
    art.article_id,
    COALESCE(art.piece_technique_id, pt.piece_technique_id) AS piece_technique_id
  FROM public.commande_cadre_release_ligne rl
  LEFT JOIN LATERAL (
    SELECT
      a.id AS article_id,
      a.piece_technique_id
    FROM public.articles a
    LEFT JOIN public.pieces_techniques apt
      ON apt.id = a.piece_technique_id
    WHERE rl.code_piece IS NOT NULL
      AND (
        a.code = btrim(rl.code_piece)
        OR apt.code_piece = btrim(rl.code_piece)
      )
    ORDER BY
      (a.code = btrim(rl.code_piece)) DESC,
      a.updated_at DESC NULLS LAST,
      a.created_at DESC NULLS LAST,
      a.id ASC
    LIMIT 1
  ) art ON TRUE
  LEFT JOIN LATERAL (
    SELECT pt.id AS piece_technique_id
    FROM public.pieces_techniques pt
    WHERE rl.code_piece IS NOT NULL
      AND pt.code_piece = btrim(rl.code_piece)
    ORDER BY pt.updated_at DESC NULLS LAST, pt.created_at DESC NULLS LAST, pt.id ASC
    LIMIT 1
  ) pt ON TRUE
  WHERE rl.article_id IS NULL OR rl.piece_technique_id IS NULL
)
UPDATE public.commande_cadre_release_ligne rl
SET
  article_id = COALESCE(rl.article_id, resolved.article_id),
  piece_technique_id = COALESCE(rl.piece_technique_id, resolved.piece_technique_id)
FROM resolved
WHERE rl.id = resolved.release_line_id
  AND (resolved.article_id IS NOT NULL OR resolved.piece_technique_id IS NOT NULL);

/* -------------------------------------------------------------------------- */
/* 3) OF traceability back to originating commande line/article                 */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS commande_ligne_id BIGINT NULL;

ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS article_id UUID NULL;

CREATE INDEX IF NOT EXISTS ordres_fabrication_commande_ligne_idx
  ON public.ordres_fabrication (commande_ligne_id)
  WHERE commande_ligne_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordres_fabrication_article_idx
  ON public.ordres_fabrication (article_id)
  WHERE article_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.commande_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_commande_ligne_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_commande_ligne_id_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_article_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE SET NULL;
  END IF;
END $$;

WITH unique_alloc AS (
  SELECT
    o.id AS of_id,
    MIN(cla.commande_ligne_id) AS commande_ligne_id
  FROM public.ordres_fabrication o
  JOIN public.commande_ligne_affaire_allocation cla
    ON cla.commande_id = o.commande_id
  WHERE o.commande_id IS NOT NULL
    AND o.commande_ligne_id IS NULL
  GROUP BY o.id
  HAVING COUNT(DISTINCT cla.commande_ligne_id) = 1
), resolved AS (
  SELECT
    ua.of_id,
    ua.commande_ligne_id,
    cl.article_id
  FROM unique_alloc ua
  JOIN public.commande_ligne cl
    ON cl.id = ua.commande_ligne_id
)
UPDATE public.ordres_fabrication o
SET
  commande_ligne_id = COALESCE(o.commande_ligne_id, resolved.commande_ligne_id),
  article_id = COALESCE(o.article_id, resolved.article_id)
FROM resolved
WHERE o.id = resolved.of_id
  AND (resolved.commande_ligne_id IS NOT NULL OR resolved.article_id IS NOT NULL);

COMMIT;
