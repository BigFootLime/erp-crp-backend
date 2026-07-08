-- 20260708_gpao_achats_type.sql
--
-- GPAO B3.5 — Nomenclature d'achat séparée : catégorie de ligne d'achat (type_achat).
-- Catégorise chaque ligne de pieces_techniques_achats (matière, visserie, composant catalogue,
-- traitement, sous-traitance, certificat, divers) afin d'afficher une nomenclature d'achat
-- STRUCTURÉE et DISTINCTE de l'arborescence de fabrication. Les achats ne sont jamais des
-- nœuds fabriqués (cf. 20260708_gpao_nomenclature_versioned.sql).
--
-- ADDITIF & NON DESTRUCTIF : nouvelle colonne NOT NULL DEFAULT 'DIVERS' — les lignes existantes
-- et les INSERT qui n'indiquent pas type_achat prennent le défaut 'DIVERS' (aucune rupture du
-- flux de création). Idempotent. Pipeline db/patches (cerp_app). PostgreSQL 17. Rollback dans support/.

BEGIN;

ALTER TABLE public.pieces_techniques_achats
  ADD COLUMN IF NOT EXISTS type_achat text NOT NULL DEFAULT 'DIVERS';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_achats_type_achat_check'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_type_achat_check
      CHECK ( type_achat IN (
        'MATIERE','VISSERIE','COMPOSANT_CATALOGUE','TRAITEMENT',
        'SOUS_TRAITANCE','CERTIFICAT','DIVERS'
      ) );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_achats_type_achat_idx
  ON public.pieces_techniques_achats (piece_technique_id, type_achat);

COMMIT;
