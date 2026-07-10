-- Active PROJECT_OFFICE for the single ERP pilot account named KEENAN.
-- This seed is idempotent and never enables the feature globally.
--
-- cerp_test:
--   psql -d cerp_test -f db/seeds/project-office-pilot-keenan.sql
--
-- cerp_prod (only after dev/CI/cerp_test validation and backup, in one session):
--   SET cerp.project_office_pilot_approved = 'KEENAN';
--   \i db/seeds/project-office-pilot-keenan.sql

DO $$
DECLARE
  v_flag_id uuid;
  v_user_id integer;
  v_user_count integer;
  v_global_enabled boolean;
BEGIN
  IF current_database() = 'cerp_prod'
     AND current_setting('cerp.project_office_pilot_approved', true) IS DISTINCT FROM 'KEENAN' THEN
    RAISE EXCEPTION 'INTERDIT : validation explicite KEENAN requise avant activation pilote sur cerp_prod';
  END IF;

  SELECT id, enabled
    INTO v_flag_id, v_global_enabled
    FROM public.app_feature_flags
   WHERE key = 'PROJECT_OFFICE';

  IF v_flag_id IS NULL THEN
    RAISE EXCEPTION 'Flag PROJECT_OFFICE absent — exécuter d''abord project-office-flag-baseline.sql';
  END IF;

  IF current_database() = 'cerp_prod' AND v_global_enabled THEN
    RAISE EXCEPTION 'INTERDIT : PROJECT_OFFICE doit rester désactivé globalement sur cerp_prod';
  END IF;

  SELECT count(*), min(id)
    INTO v_user_count, v_user_id
    FROM public.users
   WHERE upper(btrim(username)) = 'KEENAN';

  IF v_user_count <> 1 THEN
    RAISE EXCEPTION 'Utilisateur pilote KEENAN introuvable ou ambigu (% correspondances)', v_user_count;
  END IF;

  INSERT INTO public.app_feature_flag_users (feature_flag_id, user_id, enabled)
  VALUES (v_flag_id, v_user_id, true)
  ON CONFLICT (feature_flag_id, user_id)
  DO UPDATE SET enabled = EXCLUDED.enabled;
END $$;
