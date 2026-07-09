-- Rollback de 20260708_gpao_piece_article_unique.sql (GPAO B5).
-- Retire l'index partiel unique inverse. L'index non-unique pieces_techniques_article_id_idx reste.
BEGIN;
DROP INDEX IF EXISTS public.pieces_techniques_article_id_uniq;
COMMIT;
