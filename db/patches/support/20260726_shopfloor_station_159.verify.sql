-- 20260726_shopfloor_station_159.verify.sql
-- LECTURE SEULE (sauf section 6, entièrement annulée par ROLLBACK).
-- À exécuter APRÈS le patch. Chaque ligne doit afficher `ok = true`.

\echo '=== #159 VERIFY — poste opérateur tablette ==='
SELECT current_database() AS base, now() AS at;

\echo '--- 1) Tables et vue créées ---'
SELECT 'tables_creees' AS controle,
       (to_regclass('public.production_devices')          IS NOT NULL
    AND to_regclass('public.operator_badge_credentials')  IS NOT NULL
    AND to_regclass('public.operator_device_sessions')    IS NOT NULL
    AND to_regclass('public.station_audit_events')        IS NOT NULL
    AND to_regclass('public.production_shift_handovers')  IS NOT NULL
    AND to_regclass('public.v_station_machine_occupancy') IS NOT NULL) AS ok;

\echo '--- 2) Contraintes structurantes ---'
SELECT 'contraintes' AS controle, count(*) = 6 AS ok, count(*) AS trouvees
FROM pg_constraint
WHERE conname IN (
  'production_devices_public_code_159_uq',
  'production_devices_fixed_machine_159_ck',
  'operator_badge_credentials_hash_159_uq',
  'operator_device_sessions_token_159_uq',
  'production_shift_handovers_distinct_159_ck',
  'operator_device_sessions_handover_159_fk'
);

\echo '--- 3) Index d''unicité fonctionnels ---'
SELECT 'index_uniques' AS controle, count(*) = 3 AS ok, count(*) AS trouves
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'operator_device_sessions_one_live_159_uq',
    'production_shift_handovers_idem_159_uq',
    'production_devices_status_159_idx'
  );

\echo '--- 4) Triggers d''intégrité ---'
SELECT 'triggers' AS controle, count(*) = 4 AS ok, count(*) AS trouves
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname IN (
    'trg_station_audit_append_only_159',
    'trg_shift_handover_immutable_159',
    'trg_production_devices_touch_159',
    'trg_operator_badge_credentials_touch_159'
  );

\echo '--- 5) Propriétaires : audit reste postgres, le reste passe à cerp_app ---'
SELECT 'proprietaires' AS controle,
       bool_and(
         CASE
           WHEN c.relname = 'station_audit_events' THEN pg_get_userbyid(c.relowner) = 'postgres'
           ELSE pg_get_userbyid(c.relowner) = 'cerp_app'
                OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
         END
       ) AS ok,
       string_agg(c.relname || '=' || pg_get_userbyid(c.relowner), ', ' ORDER BY c.relname) AS detail
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relname IN (
  'production_devices', 'operator_badge_credentials', 'operator_device_sessions',
  'station_audit_events', 'production_shift_handovers'
);

\echo '--- 6) Comportement réel sous le rôle applicatif (transaction annulée) ---'
BEGIN;
SET LOCAL ROLE cerp_app;

-- 6a) Le code public est généré par la base.
SELECT 'code_public_genere' AS controle,
       public.fn_production_device_next_public_code('TAB') ~ '^TAB-[0-9]{4}$' AS ok;

-- 6b) Lecture possible sur chaque table (absence de 42501).
SELECT 'lecture_cerp_app' AS controle, true AS ok, (
  (SELECT count(*) FROM public.production_devices)
  + (SELECT count(*) FROM public.operator_device_sessions)
  + (SELECT count(*) FROM public.operator_badge_credentials)
  + (SELECT count(*) FROM public.station_audit_events)
  + (SELECT count(*) FROM public.production_shift_handovers)
  + (SELECT count(*) FROM public.v_station_machine_occupancy)
) IS NOT NULL AS lignes_lisibles;

-- 6c) Le journal d'audit accepte l'insertion…
INSERT INTO public.station_audit_events (event_type, outcome, reason_code, detail)
VALUES ('VERIFY_PROBE_159', 'SUCCESS', 'VERIFY', '{"source":"verify"}'::jsonb);

-- 6d) …et refuse la modification et la suppression.
DO $$
DECLARE
  v_id bigint;
  v_update_blocked boolean := false;
  v_delete_blocked boolean := false;
BEGIN
  SELECT id INTO v_id FROM public.station_audit_events WHERE event_type = 'VERIFY_PROBE_159' LIMIT 1;

  BEGIN
    UPDATE public.station_audit_events SET reason_code = 'HACK' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_update_blocked := true;
  END;

  BEGIN
    DELETE FROM public.station_audit_events WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_delete_blocked := true;
  END;

  IF NOT (v_update_blocked AND v_delete_blocked) THEN
    RAISE EXCEPTION 'VERIFY #159 KO : station_audit_events n''est pas append-only (update_bloque=%, delete_bloque=%)',
      v_update_blocked, v_delete_blocked;
  END IF;

  RAISE NOTICE 'VERIFY #159 : station_audit_events append-only confirme';
END$$;

-- 6e) Une tablette FIXED sans machine doit être refusée par la base.
DO $$
DECLARE
  v_blocked boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.production_devices (public_code, label, assignment_mode, machine_id)
    VALUES ('ZZVERIFY-9999', 'sonde verify', 'FIXED', NULL);
  EXCEPTION WHEN check_violation THEN
    v_blocked := true;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'VERIFY #159 KO : une tablette FIXED sans machine a ete acceptee';
  END IF;

  RAISE NOTICE 'VERIFY #159 : contrainte FIXED/machine confirmee';
END$$;

RESET ROLE;
ROLLBACK;

\echo '--- 7) Aucune donnée de test persistée ---'
SELECT 'aucune_sonde_persistee' AS controle,
       NOT EXISTS (SELECT 1 FROM public.station_audit_events WHERE event_type = 'VERIFY_PROBE_159')
       AND NOT EXISTS (SELECT 1 FROM public.production_devices WHERE public_code = 'ZZVERIFY-9999') AS ok;

\echo '--- 8) FRONTIÈRE RH intacte : aucune table #119 touchée par ce patch ---'
SELECT 'frontiere_rh' AS controle,
       NOT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('hr_time_clock_devices', 'hr_badge_credentials', 'hr_time_events')
           AND column_name LIKE '%station%'
       ) AS ok;

\echo '--- 9) FRONTIÈRE MOTEUR : #159 n''a créé aucune table de temps ni de quantité ---'
SELECT 'frontiere_moteur' AS controle,
       NOT EXISTS (
         SELECT 1 FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relkind = 'r'
           AND c.relname ~ '^station_.*(time|pointage|quantit|duration)'
       ) AS ok;

\echo '=== FIN VERIFY #159 ==='
