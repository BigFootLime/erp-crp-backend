-- VERIFY — propriété des tables du module « Temps & Déplacements ».   (sur cerp_test)
--
--   sudo -u postgres psql -d cerp_test -f db/privileged/20260709_hr_module_ownership.verify.sql
--
-- Attendu :
--   14 tables CRUD  -> owner = cerp_app
--   hr_time_events  -> owner = postgres        (append-only)
--   crud_not_cerp_app = 0                       (aucune table CRUD hors cerp_app)

\pset pager off

\echo '### propriétaires des tables hr_* (attendu: hr_time_events=postgres, le reste=cerp_app)'
SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'hr_%'
ORDER BY tablename;

\echo '### tables CRUD qui ne seraient PAS owned par cerp_app (attendu: 0)'
SELECT count(*) AS crud_not_cerp_app
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'hr_%'
  AND tablename <> 'hr_time_events'
  AND tableowner <> 'cerp_app';

\echo '### hr_time_events reste-t-il bien postgres (append-only) ? (attendu: t)'
SELECT (tableowner = 'postgres') AS hr_time_events_is_postgres
FROM pg_tables WHERE schemaname = 'public' AND tablename = 'hr_time_events';
