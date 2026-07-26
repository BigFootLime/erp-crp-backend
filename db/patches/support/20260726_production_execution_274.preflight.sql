-- 20260726_production_execution_274.preflight.sql
-- Issue #274 — À exécuter AVANT le patch. Lecture seule, ne modifie rien.
--
-- Objet : vérifier que la base cible porte bien les deux moteurs de temps
-- historiques, mesurer l'existant, et surtout DÉTECTER les chevauchements
-- préexistants qui empêcheraient la pose des contraintes d'exclusion.

\echo '=== #274 preflight — base cible ==='
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

\echo '--- Pré-requis structurels (attendu: toutes les lignes à true) ---'
SELECT
  to_regclass('public.production_pointages')       IS NOT NULL AS has_production_pointages,
  to_regclass('public.production_pointage_events') IS NOT NULL AS has_pointage_events,
  to_regclass('public.of_operations')              IS NOT NULL AS has_of_operations,
  to_regclass('public.of_time_logs')               IS NOT NULL AS has_of_time_logs,
  to_regclass('public.ordres_fabrication')         IS NOT NULL AS has_ofs,
  EXISTS (SELECT 1 FROM pg_type WHERE typname = 'of_time_log_type')              AS has_of_time_log_type,
  EXISTS (SELECT 1 FROM pg_type WHERE typname = 'production_pointage_time_type') AS has_pointage_time_type,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'tg_set_updated_at')             AS has_updated_at_helper;

\echo '--- Extensions requises (pgcrypto, btree_gist) ---'
SELECT name, installed_version
FROM pg_available_extensions
WHERE name IN ('pgcrypto', 'btree_gist');

\echo '--- Volumétrie existante des deux moteurs ---'
SELECT 'production_pointages' AS moteur, count(*) AS lignes,
       count(*) FILTER (WHERE status = 'RUNNING') AS en_cours,
       count(*) FILTER (WHERE validated_at IS NOT NULL) AS valides
FROM public.production_pointages
UNION ALL
SELECT 'of_time_logs', count(*), count(*) FILTER (WHERE ended_at IS NULL), 0
FROM public.of_time_logs;

\echo '--- Temps déjà comptabilisé (heures) : mesure du sous-comptage actuel ---'
-- Aujourd''hui, seul of_time_logs alimente of_operations.temps_total_real.
-- Le temps saisi via production_pointages est invisible du coût et du planning.
SELECT
  ROUND(COALESCE(SUM(t.duration_minutes), 0)::numeric / 60.0, 3) AS heures_of_time_logs,
  (SELECT ROUND(COALESCE(SUM(p.duration_minutes), 0)::numeric / 60.0, 3)
     FROM public.production_pointages p
    WHERE p.status = 'DONE' AND p.operation_id IS NOT NULL) AS heures_pointages_rattachees,
  (SELECT ROUND(COALESCE(SUM(op.temps_total_real), 0), 3)
     FROM public.of_operations op) AS heures_persistees_of_operations
FROM public.of_time_logs t;

\echo '--- BLOQUANT POTENTIEL : chevauchements opérateur préexistants ---'
-- Si ce compte est > 0, la contrainte d''exclusion ne sera PAS posée par le
-- patch (il émettra un NOTICE et continuera). Une reprise humaine est alors
-- nécessaire avant de compter sur la garantie base.
SELECT count(*) AS chevauchements_operateur
FROM public.production_pointages a
JOIN public.production_pointages b
  ON b.id <> a.id
 AND b.operator_user_id = a.operator_user_id
 AND b.status IN ('RUNNING', 'DONE')
 AND tstzrange(b.start_ts, COALESCE(b.end_ts, 'infinity'::timestamptz), '[)')
     && tstzrange(a.start_ts, COALESCE(a.end_ts, 'infinity'::timestamptz), '[)')
WHERE a.status IN ('RUNNING', 'DONE');

\echo '--- BLOQUANT POTENTIEL : chevauchements machine préexistants ---'
SELECT count(*) AS chevauchements_machine
FROM public.production_pointages a
JOIN public.production_pointages b
  ON b.id <> a.id
 AND b.machine_id = a.machine_id
 AND b.status IN ('RUNNING', 'DONE')
 AND tstzrange(b.start_ts, COALESCE(b.end_ts, 'infinity'::timestamptz), '[)')
     && tstzrange(a.start_ts, COALESCE(a.end_ts, 'infinity'::timestamptz), '[)')
WHERE a.status IN ('RUNNING', 'DONE') AND a.machine_id IS NOT NULL;

\echo '--- Détail des 20 premiers chevauchements opérateur (pour reprise humaine) ---'
SELECT a.id AS pointage_a, b.id AS pointage_b, a.operator_user_id,
       a.start_ts AS a_debut, a.end_ts AS a_fin,
       b.start_ts AS b_debut, b.end_ts AS b_fin
FROM public.production_pointages a
JOIN public.production_pointages b
  ON b.id > a.id
 AND b.operator_user_id = a.operator_user_id
 AND b.status IN ('RUNNING', 'DONE')
 AND tstzrange(b.start_ts, COALESCE(b.end_ts, 'infinity'::timestamptz), '[)')
     && tstzrange(a.start_ts, COALESCE(a.end_ts, 'infinity'::timestamptz), '[)')
WHERE a.status IN ('RUNNING', 'DONE')
ORDER BY a.start_ts
LIMIT 20;

\echo '--- Objets #274 déjà présents (rejeu du patch) ---'
SELECT
  to_regclass('public.production_activity_categories')     IS NOT NULL AS has_categories,
  to_regclass('public.production_quantity_declarations')   IS NOT NULL AS has_declarations,
  to_regclass('public.production_execution_idempotency')   IS NOT NULL AS has_idempotency,
  to_regclass('public.v_production_active_executions')     IS NOT NULL AS has_active_view,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'of_time_logs'
             AND column_name = 'pointage_id') AS has_time_log_correlation;

\echo '=== #274 preflight terminé ==='
