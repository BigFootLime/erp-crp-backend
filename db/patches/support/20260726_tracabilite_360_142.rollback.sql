-- Rollback GARDÉ #142.
--
-- Ce script ne s'exécute QUE si la table de consommation matière est vide,
-- c'est-à-dire si aucune preuve industrielle n'a encore été produite. Dès
-- qu'une seule consommation est enregistrée, le rollback échoue volontairement :
-- une preuve industrielle ne se supprime pas parce qu'un déploiement s'est mal
-- passé. Dans ce cas, on avance (correctif additif), on ne recule pas.
--
-- Les index créés par le patch sont purement additifs et sans effet de bord :
-- on peut les retirer sans risque. Les colonnes as-built sont conservées
-- (retirer une colonne portant une empreinte déjà calculée détruirait une
-- preuve d'intégrité).

BEGIN;

DO $$
DECLARE
  rows_present bigint := 0;
BEGIN
  IF to_regclass('public.of_material_consumptions') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.of_material_consumptions' INTO rows_present;
    IF rows_present > 0 THEN
      RAISE EXCEPTION
        'Rollback refusé : % consommation(s) matière enregistrée(s). Une preuve industrielle ne se supprime pas.',
        rows_present;
    END IF;
    EXECUTE 'DROP TRIGGER IF EXISTS trg_protect_of_material_consumption ON public.of_material_consumptions';
    EXECUTE 'DROP TABLE public.of_material_consumptions';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.fn_protect_of_material_consumption();

DROP INDEX IF EXISTS public.stock_movement_lines_id_article_lot_uq;
DROP INDEX IF EXISTS public.stock_movements_source_document_idx;
DROP INDEX IF EXISTS public.stock_movements_reversal_of_idx;
DROP INDEX IF EXISTS public.stock_reservations_of_consumed_idx;
DROP INDEX IF EXISTS public.stock_reservations_bl_ligne_idx;
DROP INDEX IF EXISTS public.reception_fournisseur_stock_receipts_line_idx;
DROP INDEX IF EXISTS public.reception_fournisseur_stock_receipts_movement_idx;
DROP INDEX IF EXISTS public.reception_incoming_inspections_line_idx;
DROP INDEX IF EXISTS public.reception_incoming_measurements_inspection_idx;
DROP INDEX IF EXISTS public.of_operations_of_idx;
DROP INDEX IF EXISTS public.production_pointages_operation_idx;
DROP INDEX IF EXISTS public.production_pointages_of_idx;
DROP INDEX IF EXISTS public.bon_livraison_ligne_bl_idx;
DROP INDEX IF EXISTS public.bon_livraison_delivery_proofs_bl_idx;
DROP INDEX IF EXISTS public.bon_livraison_commande_idx;
DROP INDEX IF EXISTS public.bon_livraison_affaire_idx;
DROP INDEX IF EXISTS public.quality_release_decision_control_idx;
DROP INDEX IF EXISTS public.quality_action_nc_idx;
DROP INDEX IF EXISTS public.quality_derogation_lot_idx;
DROP INDEX IF EXISTS public.quality_derogation_of_idx;
DROP INDEX IF EXISTS public.quality_derogation_nc_idx;
DROP INDEX IF EXISTS public.metrologie_certificats_equipement_date_idx;
DROP INDEX IF EXISTS public.receptions_fournisseurs_cf_idx;
DROP INDEX IF EXISTS public.lots_lot_code_lower_idx;
DROP INDEX IF EXISTS public.lots_supplier_lot_code_lower_idx;
DROP INDEX IF EXISTS public.ordres_fabrication_numero_lower_idx;
DROP INDEX IF EXISTS public.articles_code_lower_idx;
DROP INDEX IF EXISTS public.bon_livraison_numero_lower_idx;
DROP INDEX IF EXISTS public.receptions_fournisseurs_no_lower_idx;
DROP INDEX IF EXISTS public.commande_fournisseur_code_lower_idx;
DROP INDEX IF EXISTS public.commande_client_numero_lower_idx;
DROP INDEX IF EXISTS public.affaire_reference_lower_idx;
DROP INDEX IF EXISTS public.non_conformity_reference_lower_idx;
DROP INDEX IF EXISTS public.quality_derogation_code_lower_idx;
DROP INDEX IF EXISTS public.metrologie_equipements_code_lower_idx;
DROP INDEX IF EXISTS public.pieces_techniques_code_lower_idx;
DROP INDEX IF EXISTS public.traceability_links_source_lookup_idx;
DROP INDEX IF EXISTS public.traceability_links_target_lookup_idx;

COMMIT;
