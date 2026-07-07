-- 20260707_users_view_minimal.sql   (PRIVILEGED — SUPERUSER ONLY)
--
-- ISO/IEC 27001:2022 A.8.24 / A.5.34 — minimisation, préparation avant CA-RGPD-01.
-- Réduit l'exposition inutile de données sensibles dans la vue public.users_view.
--
-- CONTEXTE
--   users_view exposait password, salary, national_id, date_of_birth, adresse (address/lane/
--   house_no/postcode/country), gender, tel_no et les dates d'emploi — alors qu'AUCUN code
--   applicatif ne l'utilise (vérifié : la table `users` est lue directement ; l'auth lit le
--   mot de passe FROM users). La vue n'a aucun objet dépendant.
--
-- CE QUE FAIT LA MIGRATION
--   Recrée users_view avec le strict nécessaire à l'administration standard, retire toutes
--   les colonnes sensibles, conserve `is_minor` DÉRIVÉ (sans exposer la date de naissance),
--   déplace la propriété au superuser et ne laisse que SELECT au rôle applicatif.
--
--   CONSERVÉ  : id, username, name, surname, email, role, status, profile_picture,
--               last_login, created_at, is_minor (dérivé).
--   RETIRÉ    : password, tel_no, gender, address, lane, house_no, postcode, country,
--               salary, date_of_birth (brute), employment_date, employment_end_date,
--               national_id.  (social_security_number n'y figurait déjà pas.)
--
-- POURQUOI SUPERUSER / db/privileged
--   `CREATE OR REPLACE VIEW` ne peut pas retirer de colonnes → DROP + CREATE requis.
--   La vue appartient au rôle applicatif ; on remet la propriété au superuser et on
--   restreint à SELECT (cohérent avec CA-SEC-03). Hors pipeline `db:patches` (rôle app).
--       sudo -u postgres psql -d cerp_test -f db/privileged/20260707_users_view_minimal.sql
--       sudo -u postgres psql -d cerp_prod -f db/privileged/20260707_users_view_minimal.sql
--
-- SAFETY : non destructif (aucune ligne `users` modifiée). Idempotent.
--   Rollback : db/privileged/20260707_users_view_minimal.rollback.sql
--   Verify   : db/privileged/20260707_users_view_minimal.verify.sql
--
-- Cible : PostgreSQL. Run as SUPERUSER (postgres).

BEGIN;

-- Guard : refuse si non-superuser (ex. rôle applicatif).
DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'users_view minimal: must be applied by a superuser; current_user=% is not a superuser', current_user;
  END IF;
END
$guard$;

DROP VIEW IF EXISTS public.users_view;

CREATE VIEW public.users_view AS
SELECT
  id,
  username,
  name,
  surname,
  email,
  role,
  status,
  profile_picture,
  last_login,
  created_at,
  (date_of_birth > (CURRENT_DATE - INTERVAL '18 years')) AS is_minor
FROM public.users;

-- Propriété au superuser + lecture seule pour le rôle applicatif.
ALTER VIEW public.users_view OWNER TO postgres;
REVOKE ALL ON public.users_view FROM PUBLIC;
GRANT SELECT ON public.users_view TO cerp_app;

COMMIT;
