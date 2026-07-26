-- 20260726_production_execution_274.verify.sql
-- Issue #274 — À exécuter APRÈS le patch. Lecture seule.
--
-- Objet : prouver que la structure est en place, que le référentiel est semé,
-- et surtout que la source unique de temps ne double-compte AUCUNE minute.

\echo '=== #274 verify — base cible ==='
SELECT current_database() AS database, now() AS checked_at;

\echo '--- Objets créés (attendu: toutes les lignes à true) ---'
SELECT
  to_regclass('public.production_activity_categories')   IS NOT NULL AS has_categories,
  to_regclass('public.production_quantity_declarations') IS NOT NULL AS has_declarations,
  to_regclass('public.production_execution_idempotency') IS NOT NULL AS has_idempotency,
  to_regclass('public.v_production_active_executions')   IS NOT NULL AS has_active_view,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_production_operation_real_hours')          AS has_real_hours_fn,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_production_recompute_operation_real_time') AS has_recompute_fn,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'production_quantity_declarations_append_only') AS has_append_only_trigger;

\echo '--- Colonnes ajoutées à production_pointages (attendu: 15) ---'
SELECT count(*) AS colonnes_274
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'production_pointages'
  AND column_name IN (
    'activity_code','session_id','previous_segment_id','segment_index','source',
    'idempotency_key','correlation_id','context_snapshot','is_retroactive',
    'created_for_other_reason','submitted_at','submitted_by','rejected_at',
    'rejected_by','rejection_reason'
  );

\echo '--- Corrélation de compatibilité of_time_logs (attendu: true) ---'
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'of_time_logs' AND column_name = 'pointage_id'
) AS has_pointage_correlation;

\echo '--- Référentiel d''activités semé (attendu: 15 actives) ---'
SELECT count(*) AS categories_actives
FROM public.production_activity_categories
WHERE disabled_at IS NULL;

\echo '--- Matrice de comptabilisation du référentiel ---'
SELECT code, label, counts_operator_time, counts_machine_time, is_productive,
       requires_reason, criticality, legacy_time_type, legacy_of_time_log_type
FROM public.production_activity_categories
ORDER BY sort_order;

\echo '--- Contraintes d''exclusion anti-chevauchement ---'
-- Absentes = des chevauchements préexistaient (voir le NOTICE du patch et le
-- preflight). Ce n''est pas un échec du patch, c''est une reprise humaine due.
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.production_pointages'::regclass
  AND conname IN ('production_pointages_operator_no_overlap',
                  'production_pointages_machine_no_overlap')
ORDER BY conname;

\echo '--- PREUVE ANTI-DOUBLE-COMPTAGE : aucune minute comptée deux fois ---'
-- Compare la fonction autoritaire à une recomposition indépendante :
-- pointages canoniques DONE + résidu legacy STRICTEMENT non corrélé.
-- Ce compte DOIT être 0.
WITH independently_recomputed AS (
  SELECT
    op.id,
    ROUND((
      COALESCE((
        SELECT SUM(p.duration_minutes)
        FROM public.production_pointages p
        LEFT JOIN public.production_activity_categories c
          ON c.code = p.activity_code
        WHERE p.operation_id = op.id
          AND p.status = 'DONE'
          AND COALESCE(c.counts_operator_time, true)
      ), 0)
      +
      COALESCE((
        SELECT SUM(t.duration_minutes)
        FROM public.of_time_logs t
        WHERE t.of_operation_id = op.id
          AND t.duration_minutes IS NOT NULL
          AND t.pointage_id IS NULL
      ), 0)
    )::numeric / 60.0, 3) AS expected_hours
  FROM public.of_operations op
)
SELECT count(*) AS lignes_legacy_comptees_en_double
FROM independently_recomputed expected
WHERE public.fn_production_operation_real_hours(expected.id)
      IS DISTINCT FROM expected.expected_hours;

\echo '--- Miroirs legacy corrélés et explicitement exclus du résidu ---'
SELECT
  count(*) FILTER (WHERE pointage_id IS NOT NULL) AS lignes_miroirs_exclues,
  COALESCE(SUM(duration_minutes) FILTER (WHERE pointage_id IS NOT NULL), 0)
    AS minutes_miroirs_exclues,
  count(*) FILTER (WHERE pointage_id IS NULL) AS lignes_legacy_residuelles
FROM public.of_time_logs;

\echo '--- Cohérence : temps persisté vs source unique recalculée ---'
-- Les écarts sont NORMAUX tant que le recalcul n''a pas été rejoué sur
-- l''historique : le patch ne réécrit AUCUNE donnée métier. Cette requête
-- mesure l''ampleur du sous-comptage historique sans rien corriger.
SELECT
  count(*) AS operations,
  count(*) FILTER (
    WHERE ROUND(op.temps_total_real, 3)
       <> public.fn_production_operation_real_hours(op.id)
  ) AS operations_en_ecart,
  ROUND(COALESCE(SUM(
    public.fn_production_operation_real_hours(op.id) - op.temps_total_real
  ), 0), 3) AS heures_non_comptees_aujourdhui
FROM public.of_operations op;

\echo '--- Read-model des exécutions en cours ---'
SELECT count(*) AS executions_en_cours FROM public.v_production_active_executions;

\echo '--- Inactivité métier du patch (attendu: 0 déclaration, 0 clé) ---'
SELECT
  (SELECT count(*) FROM public.production_quantity_declarations) AS declarations_creees,
  (SELECT count(*) FROM public.production_execution_idempotency) AS cles_idempotence;

\echo '=== #274 verify terminé ==='
