-- 20260726_production_execution_274.rollback.sql
-- Issue #274 — Retour arrière du patch de suivi/pointage de production.
--
-- GARDE-FOUS :
--   * Refuse de s'exécuter ailleurs que sur une base de test.
--   * Refuse de s'exécuter si des déclarations de quantités existent : ce sont
--     des données métier réelles, elles ne se suppriment pas par script.
--   * Ne touche JAMAIS aux données historiques : `production_pointages`,
--     `production_pointage_events`, `of_time_logs` et `of_operations`
--     conservent toutes leurs lignes. Seules les colonnes ajoutées par #274
--     sont retirées.
--   * `temps_total_real` n'est pas recalculé ni remis à zéro : les valeurs
--     persistées restent celles produites par le moteur legacy.

BEGIN;

DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_dev', 'postgres') THEN
    RAISE EXCEPTION
      '#274 rollback refusé sur la base « % » : réservé aux bases de test.',
      current_database();
  END IF;

  IF to_regclass('public.production_quantity_declarations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.production_quantity_declarations) THEN
      RAISE EXCEPTION
        '#274 rollback refusé : % déclaration(s) de quantité existent. Décision humaine requise.',
        (SELECT count(*) FROM public.production_quantity_declarations);
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'production_pointages'
      AND column_name = 'session_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.production_pointages WHERE session_id IS NOT NULL) THEN
      RAISE EXCEPTION
        '#274 rollback refusé : % pointage(s) utilisent déjà le modèle par segments. Décision humaine requise.',
        (SELECT count(*) FROM public.production_pointages WHERE session_id IS NOT NULL);
    END IF;
  END IF;
END$$;

-- Read-model et fonctions
DROP VIEW IF EXISTS public.v_production_active_executions;
DROP FUNCTION IF EXISTS public.fn_production_recompute_operation_real_time(uuid);
DROP FUNCTION IF EXISTS public.fn_production_operation_real_hours(uuid);

-- Compatibilité of_time_logs (la colonne seulement, jamais les lignes)
DROP TRIGGER IF EXISTS production_mirror_legacy_time_log
  ON public.of_time_logs;
DROP FUNCTION IF EXISTS public.tg_production_mirror_legacy_time_log();
DROP INDEX IF EXISTS public.of_time_logs_pointage_id_uniq;
ALTER TABLE public.of_time_logs DROP COLUMN IF EXISTS pointage_id;

-- Idempotence et déclarations (vides, garanti par la garde ci-dessus)
DROP TABLE IF EXISTS public.production_execution_idempotency;
DROP TRIGGER IF EXISTS production_quantity_declarations_append_only
  ON public.production_quantity_declarations;
DROP FUNCTION IF EXISTS public.tg_production_quantity_declarations_append_only();
DROP TABLE IF EXISTS public.production_quantity_declarations;

-- Extensions du moteur canonique
ALTER TABLE public.production_pointages
  DROP CONSTRAINT IF EXISTS production_pointages_operator_no_overlap,
  DROP CONSTRAINT IF EXISTS production_pointages_machine_no_overlap,
  DROP CONSTRAINT IF EXISTS production_pointages_source_chk,
  DROP CONSTRAINT IF EXISTS production_pointages_rejection_pair_chk,
  DROP CONSTRAINT IF EXISTS production_pointages_submission_pair_chk,
  DROP CONSTRAINT IF EXISTS production_pointages_rejection_reason_chk,
  DROP CONSTRAINT IF EXISTS production_pointages_segment_index_chk;

DROP INDEX IF EXISTS public.production_pointages_idempotency_key_uniq;
DROP INDEX IF EXISTS public.production_pointages_session_id_idx;
DROP INDEX IF EXISTS public.production_pointages_activity_code_idx;
DROP INDEX IF EXISTS public.production_pointages_validated_at_idx;

ALTER TABLE public.production_pointages
  DROP COLUMN IF EXISTS activity_code,
  DROP COLUMN IF EXISTS session_id,
  DROP COLUMN IF EXISTS previous_segment_id,
  DROP COLUMN IF EXISTS segment_index,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS correlation_id,
  DROP COLUMN IF EXISTS context_snapshot,
  DROP COLUMN IF EXISTS is_retroactive,
  DROP COLUMN IF EXISTS created_for_other_reason,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS submitted_by,
  DROP COLUMN IF EXISTS rejected_at,
  DROP COLUMN IF EXISTS rejected_by,
  DROP COLUMN IF EXISTS rejection_reason;

-- Référentiel d'activités (données de référentiel semées par le patch)
DROP TABLE IF EXISTS public.production_activity_categories;

COMMIT;
