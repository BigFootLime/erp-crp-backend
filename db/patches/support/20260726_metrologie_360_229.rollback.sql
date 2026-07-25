\set ON_ERROR_STOP on

-- Rollback de l'issue #229 (Métrologie 360), restreint à cerp_test.
--
-- Principe : ce script ne détruit AUCUNE preuve métrologique. Il refuse de
-- s'exécuter dès qu'une exécution, une mesure, un certificat rattaché, un
-- dossier d'impact ou une quarantaine existe. Il ne sait défaire qu'un patch
-- appliqué « à blanc ».
--
-- Parties volontairement non défaites :
--   * le périmètre MET/MEX/MIA/MCH de `fn_next_issued_code_value` est laissé en
--     place (additif, et retirer MCH re-casserait le parc machines #165) ;
--   * les colonnes additives ne sont supprimées que si elles sont entièrement
--     vides, afin qu'un relevé, un état ou une localisation saisis ne soient
--     jamais perdus.

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#229 rollback is restricted to cerp_test (current: %)', current_database();
  END IF;
END $$;

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Refus si des données métier existent                                    */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  v_count bigint;
BEGIN
  IF to_regclass('public.metrologie_execution') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.metrologie_execution;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#229 rollback refused: % metrology execution(s) recorded', v_count;
    END IF;
  END IF;

  IF to_regclass('public.metrologie_impact_dossier') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.metrologie_impact_dossier;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#229 rollback refused: % impact dossier(s) recorded', v_count;
    END IF;
  END IF;

  IF to_regclass('public.metrologie_plan_version') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.metrologie_plan_version;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#229 rollback refused: % versioned plan(s) recorded', v_count;
    END IF;
  END IF;

  IF to_regclass('public.metrologie_command_receipts') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.metrologie_command_receipts;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#229 rollback refused: % idempotency receipt(s) recorded', v_count;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.metrologie_equipements
  WHERE etat NOT IN ('ACTIVE', 'SUSPENDED', 'RETIRED')
     OR quarantined_at IS NOT NULL
     OR last_conforme_execution_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION '#229 rollback refused: % equipment(s) already use a #229 governance state', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.metrologie_certificats
  WHERE execution_id IS NOT NULL OR statut <> 'VALIDE' OR numero_externe IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION '#229 rollback refused: % certificate(s) already carry #229 metadata', v_count;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Triggers et fonctions                                                   */
/* -------------------------------------------------------------------------- */

DROP TRIGGER IF EXISTS trg_protect_metrologie_impact_item_229 ON public.metrologie_impact_item;
DROP TRIGGER IF EXISTS trg_protect_metrologie_impact_229 ON public.metrologie_impact_dossier;
DROP TRIGGER IF EXISTS trg_protect_metrologie_categorie_229 ON public.metrologie_categories;
DROP TRIGGER IF EXISTS trg_metrologie_measurement_revision_append_only_229 ON public.metrologie_measurement_revision;
DROP TRIGGER IF EXISTS trg_metrologie_receipts_append_only_229 ON public.metrologie_command_receipts;
DROP TRIGGER IF EXISTS trg_metrologie_event_log_append_only_229 ON public.metrologie_event_log;
DROP TRIGGER IF EXISTS trg_protect_metrologie_certificat_229 ON public.metrologie_certificats;
DROP TRIGGER IF EXISTS trg_protect_metrologie_measurement_229 ON public.metrologie_execution_measurement;
DROP TRIGGER IF EXISTS trg_protect_metrologie_execution_229 ON public.metrologie_execution;
DROP TRIGGER IF EXISTS trg_protect_metrologie_plan_version_229 ON public.metrologie_plan_version;
DROP TRIGGER IF EXISTS trg_protect_metrologie_equipement_229 ON public.metrologie_equipements;

DROP FUNCTION IF EXISTS public.fn_protect_metrologie_impact_item_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_impact_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_categorie_229();
DROP FUNCTION IF EXISTS public.fn_metrologie_append_only_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_certificat_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_measurement_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_execution_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_plan_version_229();
DROP FUNCTION IF EXISTS public.fn_protect_metrologie_equipement_229();

/* -------------------------------------------------------------------------- */
/* 2) Tables créées par #229                                                  */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.metrologie_equipements
  DROP CONSTRAINT IF EXISTS metrologie_equipements_last_conforme_229_fkey;
ALTER TABLE public.metrologie_plan_version
  DROP CONSTRAINT IF EXISTS metrologie_plan_version_last_proof_229_fkey;
ALTER TABLE public.metrologie_certificats
  DROP CONSTRAINT IF EXISTS metrologie_certificats_execution_229_fkey;

DROP TABLE IF EXISTS public.metrologie_impact_item;
DROP TABLE IF EXISTS public.metrologie_impact_dossier;
DROP TABLE IF EXISTS public.metrologie_measurement_revision;
DROP TABLE IF EXISTS public.metrologie_execution_measurement;
DROP TABLE IF EXISTS public.metrologie_execution;
DROP TABLE IF EXISTS public.metrologie_plan_version;
DROP TABLE IF EXISTS public.metrologie_command_receipts;

/* -------------------------------------------------------------------------- */
/* 3) Colonnes additives (uniquement si vides)                                */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.metrologie_equipements
  WHERE categorie_code IS NOT NULL
     OR sous_categorie_code IS NOT NULL
     OR responsable_user_id IS NOT NULL
     OR site IS NOT NULL
     OR zone IS NOT NULL
     OR localisation_precise IS NOT NULL
     OR unite IS NOT NULL
     OR plage_min IS NOT NULL
     OR plage_max IS NOT NULL
     OR resolution IS NOT NULL
     OR mpe IS NOT NULL
     OR incertitude IS NOT NULL
     OR COALESCE(array_length(methodes, 1), 0) > 0
     OR specifications <> '{}'::jsonb;

  IF v_count > 0 THEN
    RAISE NOTICE '#229 rollback: % equipment(s) carry #229 data — additive columns kept', v_count;
  ELSE
    ALTER TABLE public.metrologie_equipements
      DROP CONSTRAINT IF EXISTS metrologie_equipements_etat_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_plage_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_positive_specs_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_quarantine_pair_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_retrait_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_categorie_229_fkey,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_sous_categorie_229_fkey,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_responsable_229_fkey,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_quarantined_by_229_fkey,
      DROP CONSTRAINT IF EXISTS metrologie_equipements_etat_changed_by_229_fkey;

    ALTER TABLE public.metrologie_equipements
      DROP COLUMN IF EXISTS categorie_code,
      DROP COLUMN IF EXISTS sous_categorie_code,
      DROP COLUMN IF EXISTS etat,
      DROP COLUMN IF EXISTS etat_motif,
      DROP COLUMN IF EXISTS etat_changed_at,
      DROP COLUMN IF EXISTS etat_changed_by,
      DROP COLUMN IF EXISTS proprietaire_service,
      DROP COLUMN IF EXISTS responsable_user_id,
      DROP COLUMN IF EXISTS site,
      DROP COLUMN IF EXISTS magasin,
      DROP COLUMN IF EXISTS zone,
      DROP COLUMN IF EXISTS localisation_precise,
      DROP COLUMN IF EXISTS date_mise_en_service,
      DROP COLUMN IF EXISTS date_retrait,
      DROP COLUMN IF EXISTS unite,
      DROP COLUMN IF EXISTS plage_min,
      DROP COLUMN IF EXISTS plage_max,
      DROP COLUMN IF EXISTS resolution,
      DROP COLUMN IF EXISTS mpe,
      DROP COLUMN IF EXISTS incertitude,
      DROP COLUMN IF EXISTS methodes,
      DROP COLUMN IF EXISTS conditions_utilisation,
      DROP COLUMN IF EXISTS restrictions,
      DROP COLUMN IF EXISTS etalon_reference,
      DROP COLUMN IF EXISTS exige_certificat,
      DROP COLUMN IF EXISTS specifications,
      DROP COLUMN IF EXISTS quarantine_reason,
      DROP COLUMN IF EXISTS quarantined_at,
      DROP COLUMN IF EXISTS quarantined_by,
      DROP COLUMN IF EXISTS last_conforme_execution_id,
      DROP COLUMN IF EXISTS last_conforme_at;
  END IF;
END $$;

DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.metrologie_certificats
  WHERE emetteur IS NOT NULL
     OR couverture <> '{}'::jsonb
     OR document_kind <> 'CERTIFICAT';

  IF v_count > 0 THEN
    RAISE NOTICE '#229 rollback: % certificate(s) carry #229 metadata — additive columns kept', v_count;
  ELSE
    ALTER TABLE public.metrologie_certificats
      DROP CONSTRAINT IF EXISTS metrologie_certificats_kind_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_certificats_statut_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_certificats_cancel_pair_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_certificats_confidentiality_229_ck,
      DROP CONSTRAINT IF EXISTS metrologie_certificats_replaced_by_229_fkey,
      DROP CONSTRAINT IF EXISTS metrologie_certificats_cancelled_by_229_fkey;

    DROP INDEX IF EXISTS public.metrologie_certificats_numero_externe_229_uq;
    DROP INDEX IF EXISTS public.metrologie_certificats_execution_229_idx;

    ALTER TABLE public.metrologie_certificats
      DROP COLUMN IF EXISTS execution_id,
      DROP COLUMN IF EXISTS document_kind,
      DROP COLUMN IF EXISTS numero_externe,
      DROP COLUMN IF EXISTS emetteur,
      DROP COLUMN IF EXISTS couverture,
      DROP COLUMN IF EXISTS statut,
      DROP COLUMN IF EXISTS cancel_reason,
      DROP COLUMN IF EXISTS cancelled_at,
      DROP COLUMN IF EXISTS cancelled_by,
      DROP COLUMN IF EXISTS replaced_by_id,
      DROP COLUMN IF EXISTS confidentiality;
  END IF;
END $$;

DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.metrologie_event_log
  WHERE correlation_id IS NOT NULL OR entity_type IS NOT NULL OR idempotency_key IS NOT NULL;

  IF v_count > 0 THEN
    RAISE NOTICE '#229 rollback: % event(s) carry #229 metadata — additive columns kept', v_count;
  ELSE
    DROP INDEX IF EXISTS public.metrologie_event_log_correlation_229_idx;
    DROP INDEX IF EXISTS public.metrologie_event_log_entity_229_idx;
    ALTER TABLE public.metrologie_event_log
      DROP COLUMN IF EXISTS entity_type,
      DROP COLUMN IF EXISTS entity_id,
      DROP COLUMN IF EXISTS correlation_id,
      DROP COLUMN IF EXISTS idempotency_key,
      DROP COLUMN IF EXISTS rule_code,
      DROP COLUMN IF EXISTS reason,
      DROP COLUMN IF EXISTS request_id,
      DROP COLUMN IF EXISTS source;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Référentiel des catégories (uniquement si inutilisé)                    */
/* -------------------------------------------------------------------------- */

DROP TABLE IF EXISTS public.metrologie_categories;

/* -------------------------------------------------------------------------- */
/* 5) Réglage historique : retour à la valeur d'origine                       */
/* -------------------------------------------------------------------------- */

UPDATE public.erp_settings
SET value_json = value_json - 'scope' - 'applies_to' - 'documented_by',
    updated_at = now()
WHERE key = 'metrologie.block_on_overdue_critical';

COMMIT;
