-- 20260726_shopfloor_station_159.rollback.sql
-- Retrait du patch #159 — poste opérateur tablette.
--
-- DESTRUCTIF. À n'exécuter QUE sur un environnement de validation, après
-- sauvegarde, et jamais sans autorisation humaine explicite.
--
-- Garde-fou : le script REFUSE de s'exécuter dès qu'une donnée réelle existe
-- (session, transmission, événement d'audit autre que les sondes de verify).
-- Un rollback qui efface l'historique d'un atelier n'est pas un rollback, c'est
-- une perte de traçabilité.

BEGIN;

DO $$
DECLARE
  v_sessions bigint := 0;
  v_handovers bigint := 0;
  v_audit bigint := 0;
  v_badges bigint := 0;
BEGIN
  IF current_database() = 'cerp_prod' THEN
    RAISE EXCEPTION 'ROLLBACK #159 refuse : cible cerp_prod';
  END IF;

  IF to_regclass('public.operator_device_sessions') IS NOT NULL THEN
    SELECT count(*) INTO v_sessions FROM public.operator_device_sessions;
  END IF;
  IF to_regclass('public.production_shift_handovers') IS NOT NULL THEN
    SELECT count(*) INTO v_handovers FROM public.production_shift_handovers;
  END IF;
  IF to_regclass('public.operator_badge_credentials') IS NOT NULL THEN
    SELECT count(*) INTO v_badges FROM public.operator_badge_credentials;
  END IF;
  IF to_regclass('public.station_audit_events') IS NOT NULL THEN
    SELECT count(*) INTO v_audit
    FROM public.station_audit_events
    WHERE event_type <> 'VERIFY_PROBE_159';
  END IF;

  IF v_sessions > 0 OR v_handovers > 0 OR v_audit > 0 OR v_badges > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK #159 refuse : donnees reelles presentes (sessions=%, transmissions=%, audit=%, badges=%). Reprise humaine requise.',
      v_sessions, v_handovers, v_audit, v_badges;
  END IF;
END$$;

-- L'ordre suit les dépendances : la FK session → transmission d'abord.
ALTER TABLE IF EXISTS public.operator_device_sessions
  DROP CONSTRAINT IF EXISTS operator_device_sessions_handover_159_fk;

DROP VIEW IF EXISTS public.v_station_machine_occupancy;

DROP TRIGGER IF EXISTS trg_shift_handover_immutable_159 ON public.production_shift_handovers;
DROP TRIGGER IF EXISTS trg_station_audit_append_only_159 ON public.station_audit_events;
DROP TRIGGER IF EXISTS trg_production_devices_touch_159 ON public.production_devices;
DROP TRIGGER IF EXISTS trg_operator_badge_credentials_touch_159 ON public.operator_badge_credentials;

DROP TABLE IF EXISTS public.production_shift_handovers;
DROP TABLE IF EXISTS public.station_audit_events;
DROP TABLE IF EXISTS public.operator_device_sessions;
DROP TABLE IF EXISTS public.operator_badge_credentials;
DROP TABLE IF EXISTS public.production_devices;

DROP FUNCTION IF EXISTS public.fn_shift_handover_immutable_159();
DROP FUNCTION IF EXISTS public.fn_station_audit_append_only_159();
DROP FUNCTION IF EXISTS public.fn_station_touch_updated_at_159();
DROP FUNCTION IF EXISTS public.fn_production_device_next_public_code(text);

DROP SEQUENCE IF EXISTS public.production_device_public_code_seq;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260726_shopfloor_station_159.sql';

COMMIT;

\echo '=== ROLLBACK #159 termine — aucune table #274, #119 ou stock touchee ==='
