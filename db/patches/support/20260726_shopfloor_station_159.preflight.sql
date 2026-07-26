-- 20260726_shopfloor_station_159.preflight.sql
-- LECTURE SEULE. À exécuter AVANT le patch, sur la base ciblée.
--
-- Objectif : prouver que le patch est applicable et qu'il n'écrasera rien.
-- Aucune écriture, aucun verrou long, aucune modification de données.

\echo '=== #159 PREFLIGHT — poste opérateur tablette ==='

SELECT current_database() AS base, now() AS at, current_user AS role_courant;

\echo '--- 1) Pré-requis (doivent tous être présents) ---'
SELECT
  to_regclass('public.machines')              IS NOT NULL AS has_machines,
  to_regclass('public.users')                 IS NOT NULL AS has_users,
  to_regclass('public.ordres_fabrication')    IS NOT NULL AS has_ofs,
  to_regclass('public.of_operations')         IS NOT NULL AS has_of_operations,
  to_regclass('public.production_pointages')  IS NOT NULL AS has_pointages_274;

\echo '--- 2) Colonnes #274 attendues sur production_pointages ---'
SELECT
  bool_or(column_name = 'activity_code') AS has_activity_code,
  bool_or(column_name = 'session_id')    AS has_session_id,
  bool_or(column_name = 'segment_index') AS has_segment_index
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'production_pointages';

\echo '--- 3) Objets #159 déjà présents (rejeu attendu : true partout) ---'
SELECT
  to_regclass('public.production_devices')          IS NOT NULL AS t_devices,
  to_regclass('public.operator_badge_credentials')  IS NOT NULL AS t_badges,
  to_regclass('public.operator_device_sessions')    IS NOT NULL AS t_sessions,
  to_regclass('public.station_audit_events')        IS NOT NULL AS t_audit,
  to_regclass('public.production_shift_handovers')  IS NOT NULL AS t_handovers,
  to_regclass('public.v_station_machine_occupancy') IS NOT NULL AS v_occupancy;

\echo '--- 4) Volumétrie existante (0 attendu sur une base vierge de #159) ---'
-- SQL dynamique : sur une base vierge, les tables n'existent pas encore et une
-- requête statique échouerait à la planification, pas à l'exécution.
DO $$
DECLARE
  v_t text;
  v_n bigint;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'production_devices', 'operator_device_sessions', 'operator_badge_credentials',
    'station_audit_events', 'production_shift_handovers'
  ] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE NOTICE '% : table absente (patch non encore applique)', v_t;
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
      RAISE NOTICE '% : % ligne(s)', v_t, v_n;
    END IF;
  END LOOP;
END$$;

\echo '--- 5) Collision de nom : rien de #159 ne doit préexister sous un autre schéma ---'
SELECT n.nspname AS schema, c.relname AS objet, c.relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN (
  'production_devices', 'operator_badge_credentials', 'operator_device_sessions',
  'station_audit_events', 'production_shift_handovers', 'v_station_machine_occupancy',
  'production_device_public_code_seq'
)
AND n.nspname <> 'public'
ORDER BY 1, 2;

\echo '--- 6) FRONTIÈRE RH : les tables #119 doivent exister SÉPARÉMENT et rester intactes ---'
SELECT
  to_regclass('public.hr_time_clock_devices') IS NOT NULL AS hr_devices_present,
  to_regclass('public.hr_badge_credentials')  IS NOT NULL AS hr_badges_present,
  (SELECT count(*) FROM public.hr_badge_credentials)  AS hr_badges_count,
  (SELECT count(*) FROM public.hr_time_clock_devices) AS hr_devices_count
WHERE to_regclass('public.hr_badge_credentials') IS NOT NULL;

\echo '--- 7) Machines disponibles pour affectation (information) ---'
SELECT count(*) FILTER (WHERE archived_at IS NULL) AS machines_actives,
       count(*)                                    AS machines_totales
FROM public.machines;

\echo '--- 8) Rôle applicatif ---'
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_present;

\echo '--- 9) Extensions requises ---'
SELECT
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS pgcrypto_installed;

\echo '=== FIN PREFLIGHT #159 — aucune écriture effectuée ==='
