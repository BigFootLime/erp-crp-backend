-- Active le flag PROJECT_OFFICE globalement — RÉSERVÉ à cerp_test.
-- Garde-fou : refuse de s'exécuter sur cerp_prod (en prod l'activation est PAR UTILISATEUR pilote).
--   sudo -u postgres psql -d cerp_test -f db/seeds/project-office-flag-enable-test.sql

DO $$
BEGIN
  IF current_database() = 'cerp_prod' THEN
    RAISE EXCEPTION 'INTERDIT : activation globale de PROJECT_OFFICE refusée sur cerp_prod (pilote uniquement via app_feature_flag_users).';
  END IF;
  UPDATE public.app_feature_flags
     SET enabled = true, updated_at = now()
   WHERE key = 'PROJECT_OFFICE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flag PROJECT_OFFICE absent — exécuter d''abord db/seeds/project-office-flag-baseline.sql';
  END IF;
END $$;
