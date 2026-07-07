-- ROLLBACK for 20260707_users_view_minimal.sql   (SUPERUSER ONLY)
--
-- Restaure la vue users_view d'origine (colonnes complètes) et sa propriété cerp_app.
--   sudo -u postgres psql -d <db> -f db/privileged/20260707_users_view_minimal.rollback.sql
--
-- Non destructif (aucune ligne `users` modifiée).

BEGIN;

DROP VIEW IF EXISTS public.users_view;

CREATE VIEW public.users_view AS
SELECT
  id,
  username,
  password,
  name,
  surname,
  email,
  tel_no,
  role,
  gender,
  address,
  lane,
  house_no,
  postcode,
  country,
  salary,
  date_of_birth,
  employment_date,
  employment_end_date,
  national_id,
  profile_picture,
  last_login,
  status,
  created_at,
  (date_of_birth > (CURRENT_DATE - INTERVAL '18 years')) AS is_minor
FROM public.users;

ALTER VIEW public.users_view OWNER TO cerp_app;

COMMIT;
