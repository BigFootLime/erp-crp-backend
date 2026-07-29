-- Rollback 20260729_surface_finish_library_admin_226.
--
-- ⚠️ DESTRUCTIF : `surface_finish_favorites` est SUPPRIMÉE avec son contenu.
-- Les favoris sont une préférence d'affichage, jamais une donnée opposable :
-- les perdre ne casse aucune traçabilité industrielle. C'est précisément
-- pourquoi ce rollback est acceptable — il ne le serait pas pour une exigence
-- de gamme ou un article.
--
-- Les colonnes d'archivage sont retirées elles aussi. Si des finitions ont été
-- archivées entre-temps, leur MOTIF disparaît alors que leur statut 'ARCHIVEE'
-- reste : relire d'abord la requête de contrôle en fin de fichier.
--
-- À n'exécuter qu'avec autorisation humaine explicite, sauvegarde faite.

BEGIN;

-- 1) Anti-doublon du référentiel.
DROP INDEX IF EXISTS public.surface_finishes_identity_uq;

-- 2) Archivage. La contrainte part avant les colonnes qu'elle référence.
ALTER TABLE public.surface_finishes
  DROP CONSTRAINT IF EXISTS surface_finishes_archive_coherent;

DROP INDEX IF EXISTS public.surface_finishes_archived_at_idx;

ALTER TABLE public.surface_finishes
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS archived_by,
  DROP COLUMN IF EXISTS archive_reason,
  DROP COLUMN IF EXISTS statut_changed_at,
  DROP COLUMN IF EXISTS statut_changed_by;

-- 3) Favoris.
DROP TABLE IF EXISTS public.surface_finish_favorites;

COMMIT;

-- Contrôle post-rollback : tout doit être `false` / absent.
-- SELECT
--   to_regclass('public.surface_finish_favorites') IS NULL          AS favorites_dropped,
--   NOT EXISTS (SELECT 1 FROM pg_indexes
--               WHERE indexname='surface_finishes_identity_uq')     AS identity_idx_dropped,
--   NOT EXISTS (SELECT 1 FROM information_schema.columns
--               WHERE table_schema='public' AND table_name='surface_finishes'
--                 AND column_name='archived_at')                    AS archive_cols_dropped,
--   (SELECT COUNT(*) FROM public.surface_finishes
--    WHERE statut = 'ARCHIVEE')                                     AS orphan_archived_finishes;
