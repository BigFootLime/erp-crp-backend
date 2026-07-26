-- Issue #146 — Index de lecture de la landing Pièces techniques.
--
-- Portée : INDEX UNIQUEMENT. Aucune table, aucune donnée, aucune contrainte, aucune règle
-- métier. Intégralement rejouable.
--
-- Le module est déjà bien indexé : `client_id`, `famille_id`, `statut`, `updated_at`,
-- `deleted_at`, `article_id`, et la version applicable est couverte par l'index unique
-- partiel `piece_technique_versions_one_applicable_uq`. Ce patch ne comble que les manques
-- réels introduits par les nouveaux filtres de complétude.

BEGIN;

DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'pieces_techniques', 'piece_technique_versions', 'pieces_techniques_operations',
    'pieces_techniques_nomenclature', 'pieces_techniques_achats', 'pieces_techniques_documents'
  ]
  LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION '#146 prerequisite missing: public.%', required_table;
    END IF;
  END LOOP;
END $$;

-- Manque réel n° 1 : `pieces_techniques_operations` n'avait AUCUN index sur sa clé
-- étrangère. Le filtre « sans gamme » (`EXISTS (… WHERE piece_technique_id = p.id)`)
-- provoquait un parcours séquentiel de la table des opérations pour chaque pièce listée.
CREATE INDEX IF NOT EXISTS pt_operations_piece_146_idx
  ON public.pieces_techniques_operations (piece_technique_id);

-- Manque réel n° 2 : le tri par défaut de la liste est `updated_at DESC` sous le filtre de
-- suppression logique. Un index composite évite un tri complet à chaque page.
CREATE INDEX IF NOT EXISTS pieces_techniques_landing_146_idx
  ON public.pieces_techniques (updated_at DESC)
  WHERE deleted_at IS NULL;

-- Manque réel n° 3 : le segment « Ensembles » est très sélectif ; index partiel.
CREATE INDEX IF NOT EXISTS pieces_techniques_ensemble_146_idx
  ON public.pieces_techniques (updated_at DESC)
  WHERE ensemble AND deleted_at IS NULL;

-- Manque réel n° 4 : le segment « sans article lié » lit la moitié complémentaire de
-- `pieces_techniques_article_id_idx`, qui est partiel sur `article_id IS NOT NULL`.
CREATE INDEX IF NOT EXISTS pieces_techniques_without_article_146_idx
  ON public.pieces_techniques (updated_at DESC)
  WHERE article_id IS NULL AND deleted_at IS NULL;

-- La recherche par référence de plan et par indice reste un `ILIKE '%…%'`, qu'aucun index
-- B-tree ne peut servir. Un index trigramme exigerait l'extension `pg_trgm` : décision
-- volontairement différée, et consignée comme limite connue plutôt qu'appliquée en
-- passant. Ces index couvrent au moins les recherches ancrées et les tris.
CREATE INDEX IF NOT EXISTS ptv_plan_reference_146_idx
  ON public.piece_technique_versions (plan_reference)
  WHERE plan_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS ptv_indice_146_idx
  ON public.piece_technique_versions (indice)
  WHERE indice IS NOT NULL;

COMMENT ON INDEX public.pt_operations_piece_146_idx IS
  'Landing Pieces techniques : filtre « sans gamme » (#146). La cle etrangere n avait aucun index.';

COMMIT;
