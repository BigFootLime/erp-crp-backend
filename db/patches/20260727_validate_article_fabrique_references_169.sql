-- Issue #169 — validate the three historical references to articles_fabrique.
--
-- The constraints were installed NOT VALID by
-- 20260319_articles_domain_subtypes.sql. The preflight proves that every
-- existing non-null article_id has a matching articles_fabrique row.
--
-- This patch changes constraint validation metadata only. It does not insert,
-- update or delete business data.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION
      'Validation #169 is restricted to cerp_test or cerp_prod, current database: %',
      current_database();
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT source.article_id
      FROM public.commande_ligne AS source
      LEFT JOIN public.articles_fabrique AS target
        ON target.article_id = source.article_id
      WHERE source.article_id IS NOT NULL
        AND target.article_id IS NULL

      UNION ALL

      SELECT source.article_id
      FROM public.commande_cadre_release_ligne AS source
      LEFT JOIN public.articles_fabrique AS target
        ON target.article_id = source.article_id
      WHERE source.article_id IS NOT NULL
        AND target.article_id IS NULL

      UNION ALL

      SELECT source.article_id
      FROM public.ordres_fabrication AS source
      LEFT JOIN public.articles_fabrique AS target
        ON target.article_id = source.article_id
      WHERE source.article_id IS NOT NULL
        AND target.article_id IS NULL
    ) AS invalid_reference
  ) THEN
    RAISE EXCEPTION
      'Validation #169 refused: at least one article_id does not reference articles_fabrique';
  END IF;
END
$guard$;

ALTER TABLE public.commande_ligne
  VALIDATE CONSTRAINT commande_ligne_article_fabrique_fk;

ALTER TABLE public.commande_cadre_release_ligne
  VALIDATE CONSTRAINT commande_cadre_release_ligne_article_fabrique_fk;

ALTER TABLE public.ordres_fabrication
  VALIDATE CONSTRAINT ordres_fabrication_article_fabrique_fk;

COMMIT;
