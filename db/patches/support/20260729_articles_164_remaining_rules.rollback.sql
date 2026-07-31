-- Issue #164 — rollback structurel protégé.
--
-- Ce rollback ne peut pas reconstruire sans ambiguïté les anciens alias de
-- profils, qui restent de toute façon présents dans le référentiel. Il refuse
-- toute suppression de colonne dès qu'une nouvelle donnée métier y est saisie.
-- Une restauration de sauvegarde est la seule reprise autorisée après usage.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION
      'Rollback #164 interdit sur %. Seule cerp_test est autorisée.',
      current_database();
  END IF;
END
$$;

DO $$
DECLARE
  v_new_values bigint;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM public.stock_nuances WHERE designation IS NULL)
    + (SELECT COUNT(*) FROM public.articles_matiere
       WHERE client_proprietaire_id IS NOT NULL
          OR longueur_coupe_mm IS NOT NULL
          OR quantite_lineaire_totale_mm IS NOT NULL)
    + (SELECT COUNT(*) FROM public.lots WHERE quantite_lineaire_totale_mm IS NOT NULL)
    + (SELECT COUNT(*) FROM public.fournisseur_catalogue WHERE pricing_basis <> 'NONE')
  INTO v_new_values;

  IF v_new_values > 0 THEN
    RAISE EXCEPTION
      'Rollback #164 refusé : % valeur(s) utilisent les nouvelles règles. Restaurer une sauvegarde validée.',
      v_new_values;
  END IF;
END
$$;

ALTER TABLE public.fournisseur_catalogue_prix_history
  DROP CONSTRAINT IF EXISTS fournisseur_catalogue_history_pricing_basis_check,
  DROP COLUMN IF EXISTS pricing_basis;

ALTER TABLE public.fournisseur_catalogue
  DROP CONSTRAINT IF EXISTS fournisseur_catalogue_pricing_basis_check,
  DROP COLUMN IF EXISTS pricing_basis;

ALTER TABLE public.lots
  DROP CONSTRAINT IF EXISTS lots_quantite_lineaire_positive_check,
  DROP COLUMN IF EXISTS quantite_lineaire_totale_mm;

ALTER TABLE public.articles_matiere
  DROP CONSTRAINT IF EXISTS articles_matiere_client_proprietaire_fk,
  DROP CONSTRAINT IF EXISTS articles_matiere_remaining_dims_positive_check,
  DROP COLUMN IF EXISTS client_proprietaire_id,
  DROP COLUMN IF EXISTS longueur_barre_source_mm,
  DROP COLUMN IF EXISTS longueur_coupe_mm,
  DROP COLUMN IF EXISTS longueur_brut_mm,
  DROP COLUMN IF EXISTS quantite_lineaire_totale_mm;

DROP TRIGGER IF EXISTS stock_nuances_density_kg_m3_sync ON public.stock_nuances;
DROP FUNCTION IF EXISTS public.sync_stock_nuance_density_kg_m3();
DROP INDEX IF EXISTS public.stock_nuances_code_normalized_uq;
ALTER TABLE public.stock_nuances
  DROP CONSTRAINT IF EXISTS stock_nuances_density_kg_m3_check,
  DROP CONSTRAINT IF EXISTS stock_nuances_code_non_blank_check,
  DROP COLUMN IF EXISTS densite_kg_m3,
  ALTER COLUMN designation SET NOT NULL;

COMMIT;
