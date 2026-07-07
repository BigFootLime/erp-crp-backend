-- ROLLBACK for db/patches/20260707_pieces_techniques_gpao_versions_gammes.sql
--
-- Retire ce qui a été ajouté (additif) : colonnes, tables, commentaires de dépréciation.
-- Non destructif pour les données existantes (les tables cibles étaient vides ; les colonnes
-- ajoutées étaient nullables et neuves).
--   psql -d <db> -f db/patches/support/20260707_pieces_techniques_gpao_versions_gammes.rollback.sql

BEGIN;

-- Colonnes additives (FK vers les nouvelles tables) — retirées AVANT les tables.
ALTER TABLE public.pieces_techniques_nomenclature
  DROP COLUMN IF EXISTS parent_piece_technique_version_id,
  DROP COLUMN IF EXISTS child_piece_technique_version_id,
  DROP COLUMN IF EXISTS child_article_id;

ALTER TABLE public.pieces_techniques_operations
  DROP COLUMN IF EXISTS gamme_id,
  DROP COLUMN IF EXISTS machine_id;

-- Nouvelles tables (gammes → versions : drop gammes d'abord).
DROP TABLE IF EXISTS public.gammes;
DROP TABLE IF EXISTS public.piece_technique_versions;

-- Retirer les commentaires de dépréciation.
DO $$
BEGIN
  IF to_regclass('public.piece_technique') IS NOT NULL THEN EXECUTE 'COMMENT ON TABLE public.piece_technique IS NULL'; END IF;
  IF to_regclass('public.operation_technique') IS NOT NULL THEN EXECUTE 'COMMENT ON TABLE public.operation_technique IS NULL'; END IF;
  IF to_regclass('public.achat_technique') IS NOT NULL THEN EXECUTE 'COMMENT ON TABLE public.achat_technique IS NULL'; END IF;
END $$;

COMMIT;
