-- 20260709_hr_time_events_append_only.sql   (PRIVILEGED — SUPERUSER ONLY)
--
-- Module « Temps & Déplacements » — rend public.hr_time_events APPEND-ONLY pour le rôle
-- applicatif (cerp_app). Le relevé de badgeage brut est une preuve légale/RGPD : il ne doit
-- jamais être modifié ni supprimé par l'application (toute correction passe par
-- public.hr_time_adjustments). Miroir de 20260707_erp_audit_logs_append_only.sql (CA-SEC-03,
-- ISO/IEC 27001:2022 A.8.15).
--
-- POURQUOI HORS db/patches
--   Le runner db:patches applique en tant que cerp_app ; or un OWNER de table contourne
--   GRANT/REVOKE et peut DISABLE TRIGGER. L'immuabilité réelle exige de déplacer la propriété
--   HORS du rôle applicatif, ce que seul un SUPERUSER peut faire. À appliquer par un DBA :
--       sudo -u postgres psql -d cerp_test -f db/privileged/20260709_hr_time_events_append_only.sql
--       sudo -u postgres psql -d cerp_prod -f db/privileged/20260709_hr_time_events_append_only.sql   (T10 seulement)
--   NON pris en charge par `npm run db:patches:up`.
--
-- CE QUE ÇA FAIT
--   1. Propriété de la table → postgres (hors rôle applicatif).
--   2. cerp_app restreint à INSERT + SELECT (pas d'UPDATE/DELETE/TRUNCATE).
--   3. Trigger append-only (bloque UPDATE/DELETE/TRUNCATE pour tous, y compris l'owner).
--   (PK uuid via gen_random_uuid → pas de séquence à réassigner.)
--
-- MAINTENANCE CONTRÔLÉE (superuser only) — rétention/anonymisation RGPD :
--       SET session_replication_role = 'replica';
--       DELETE FROM public.hr_time_events WHERE ... ;   -- selon barème de conservation
--       SET session_replication_role = 'origin';
--
-- SAFETY : idempotent (ré-exécutable), non destructif. Rollback/verify fournis à côté.
-- Cible : PostgreSQL 17. Exécuter en SUPERUSER (postgres).

BEGIN;

DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'hr_time_events append-only: doit être appliqué par un superuser; current_user=% ne l''est pas', current_user;
  END IF;
END
$guard$;

DO $mig$
BEGIN
  IF to_regclass('public.hr_time_events') IS NULL THEN
    RAISE NOTICE 'public.hr_time_events absente — appliquer d''abord db/patches/20260709_hr_temps_deplacements.sql';
    RETURN;
  END IF;

  -- 1) Propriété hors rôle applicatif.
  EXECUTE 'ALTER TABLE public.hr_time_events OWNER TO postgres';

  -- 2) Moindre privilège : INSERT + SELECT uniquement pour cerp_app.
  EXECUTE 'REVOKE ALL ON public.hr_time_events FROM cerp_app';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON public.hr_time_events FROM PUBLIC';
  EXECUTE 'GRANT SELECT, INSERT ON public.hr_time_events TO cerp_app';
END
$mig$;

-- 3) Backstop append-only. Fire pour TOUS les rôles (superuser bypass via session_replication_role).
CREATE OR REPLACE FUNCTION public.hr_time_events_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'hr_time_events est append-only : % non permis (les corrections passent par hr_time_adjustments)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_hr_time_events_no_update ON public.hr_time_events;
CREATE TRIGGER trg_hr_time_events_no_update
  BEFORE UPDATE ON public.hr_time_events
  FOR EACH ROW EXECUTE FUNCTION public.hr_time_events_prevent_mutation();

DROP TRIGGER IF EXISTS trg_hr_time_events_no_delete ON public.hr_time_events;
CREATE TRIGGER trg_hr_time_events_no_delete
  BEFORE DELETE ON public.hr_time_events
  FOR EACH ROW EXECUTE FUNCTION public.hr_time_events_prevent_mutation();

DROP TRIGGER IF EXISTS trg_hr_time_events_no_truncate ON public.hr_time_events;
CREATE TRIGGER trg_hr_time_events_no_truncate
  BEFORE TRUNCATE ON public.hr_time_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.hr_time_events_prevent_mutation();

COMMIT;
