-- 20260708_gpao_piece_article_unique.sql
--
-- GPAO B5 — unicité inverse du lien pièce↔article : au plus UN article principal par pièce côté
-- pieces_techniques.article_id (miroir des index côté articles : articles_piece_technique_id_uniq
-- + articles_fabrique_piece_uniq). Rend la relation strictement 1:1 : toute dérive (deux pièces
-- pointant le même article) devient une erreur DB au lieu d'une corruption silencieuse.
--
-- ADDITIF & NON DESTRUCTIF : ajoute un index partiel unique (l'index non-unique préexistant
-- pieces_techniques_article_id_idx est laissé en place, redondant mais inoffensif). cerp_test = 0
-- ligne concernée → sûr. Idempotent. Pipeline db/patches (cerp_app). Rollback dans support/.
-- cerp_prod : appliqué UNIQUEMENT au gate B7 (backup + verify).

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS pieces_techniques_article_id_uniq
  ON public.pieces_techniques (article_id)
  WHERE article_id IS NOT NULL;

COMMIT;
