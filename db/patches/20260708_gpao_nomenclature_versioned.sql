-- 20260708_gpao_nomenclature_versioned.sql
--
-- GPAO B2.3 — nomenclature/arborescence versionnée + séparation fabrication ⟂ achats.
-- Une ligne de nomenclature de FABRICATION est SOIT une sous-pièce fabriquée
-- (child_piece_technique_id, avec sa version child_piece_technique_version_id) SOIT un
-- composant article non fabriqué (child_article_id) — jamais les deux. Les achats "purs"
-- (matière, visserie, traitements, sous-traitance) restent dans pieces_techniques_achats et
-- N'APPARAISSENT PAS dans l'arborescence de fabrication.
--
-- ADDITIF & NON DESTRUCTIF : les colonnes parent/child_piece_technique_version_id et
-- child_article_id existent déjà (P2, nullables). On relâche seulement le NOT NULL de
-- child_piece_technique_id (table vide → sûr) et on ajoute un CHECK XOR. Les insertions
-- existantes (qui fournissent toujours child_piece_technique_id) restent valides (1+0=1).
-- Idempotent. Pipeline db/patches (cerp_app). Cible : PostgreSQL 17. Rollback dans support/.

BEGIN;

ALTER TABLE public.pieces_techniques_nomenclature ALTER COLUMN child_piece_technique_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_nomenclature_child_xor_article'
      AND conrelid = 'public.pieces_techniques_nomenclature'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_nomenclature
      ADD CONSTRAINT pt_nomenclature_child_xor_article
      CHECK ( (child_piece_technique_id IS NOT NULL)::int + (child_article_id IS NOT NULL)::int = 1 );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_nomenclature_child_article_idx
  ON public.pieces_techniques_nomenclature (child_article_id) WHERE child_article_id IS NOT NULL;

COMMIT;
