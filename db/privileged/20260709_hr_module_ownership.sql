-- 20260709_hr_module_ownership.sql   (PRIVILEGED — SUPERUSER ONLY)
--
-- Module « Temps & Déplacements » — normalise la PROPRIÉTÉ des 14 tables CRUD vers cerp_app.
--
-- POURQUOI
--   La migration db/patches/20260709_hr_temps_deplacements.sql crée les tables. Appliquée
--   par le RUNNER (as cerp_app) → cerp_app en est owner (rien à faire). Mais appliquée
--   directement en `postgres` (hors runner — p.ex. cerp_test dont le .env du runner pointe
--   cerp_prod, ou une application DBA), les tables restent postgres-owned et cerp_app ne peut
--   pas les manipuler. Ce fichier rend la propriété REPRODUCTIBLE quel que soit le mode
--   d'application (idempotent : no-op si déjà cerp_app).
--
--   NB : hr_time_events est VOLONTAIREMENT EXCLU — il doit rester owned par postgres
--   (append-only, cf. 20260709_hr_time_events_append_only.sql).
--
--   `ALTER TABLE ... OWNER TO` ne supporte PAS une liste de tables → une instruction par
--   table (ici via une boucle DO).
--
--   sudo -u postgres psql -d cerp_test -f db/privileged/20260709_hr_module_ownership.sql
--   sudo -u postgres psql -d cerp_prod -f db/privileged/20260709_hr_module_ownership.sql   (T10 seulement)
--
-- SAFETY : idempotent, non destructif. Rollback/verify fournis à côté. Superuser (postgres).

BEGIN;

DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'hr_module_ownership: doit être appliqué par un superuser; current_user=% ne l''est pas', current_user;
  END IF;
END
$guard$;

DO $own$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_employees','hr_time_rule_sets','hr_employment_contracts','hr_work_schedules',
    'hr_time_clock_devices','hr_badge_credentials','hr_work_sessions','hr_timesheet_days',
    'hr_timesheet_weeks','hr_time_adjustments','hr_time_anomalies','hr_vehicles',
    'hr_kilometer_entries','hr_payroll_export_batches'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', t);
    ELSE
      RAISE NOTICE 'hr_module_ownership: table public.% absente — ignorée', t;
    END IF;
  END LOOP;
END
$own$;

COMMIT;
