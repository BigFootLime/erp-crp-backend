-- VERIFY users_view minimal exposure   (SUPERUSER, on cerp_test)
--
--   sudo -u postgres psql -d cerp_test -f db/privileged/20260707_users_view_minimal.verify.sql
--
-- Attendu :
--   owner            = postgres
--   columns          = id, username, name, surname, email, role, status,
--                      profile_picture, last_login, created_at, is_minor
--   sensitive_leaks  = 0
--   cerp_app SELECT  = fonctionne (renvoie un count, aucune valeur sensible affichée)
--   cerp_app grants  = SELECT

\pset pager off
\set ON_ERROR_STOP off

\echo '### view owner (expect postgres)'
SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'users_view';

\echo '### exposed columns'
SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users_view';

\echo '### sensitive columns still exposed (expect 0)'
SELECT count(*) AS sensitive_leaks
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users_view'
  AND column_name IN (
    'password','salary','national_id','date_of_birth','social_security_number',
    'address','tel_no','gender','lane','house_no','postcode','country',
    'employment_date','employment_end_date'
  );

\echo '### cerp_app can still read the minimal view (count only, no values)'
SET ROLE cerp_app;
SELECT count(*) AS readable_rows FROM public.users_view;
RESET ROLE;

\echo '### cerp_app grants on the view (expect SELECT)'
SELECT COALESCE(string_agg(privilege_type, ',' ORDER BY privilege_type), '(none)') AS cerp_app_privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'users_view' AND grantee = 'cerp_app';
