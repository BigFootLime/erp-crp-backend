-- VERIFY — hr_time_events append-only.   (SUPERUSER, sur cerp_test)
--
--   sudo -u postgres psql -d cerp_test -f db/privileged/20260709_hr_time_events_append_only.verify.sql
--
-- Résultat attendu :
--   owner       = postgres
--   cerp_app    = INSERT,SELECT
--   triggers    = trg_hr_time_events_no_delete, _no_truncate, _no_update  (3)
--   [1] cerp_app INSERT -> SUCCESS
--   [2] cerp_app UPDATE -> ERROR permission denied            (couche privilèges)
--   [3] cerp_app DELETE -> ERROR permission denied            (couche privilèges)
--   [4] owner    UPDATE -> ERROR append-only ...              (trigger backstop)
--   leftover    = 0                                            (fixture nettoyée)

\pset pager off
\set ON_ERROR_STOP off

\echo '### owner (expect: postgres)'
SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='hr_time_events';

\echo '### cerp_app grants (expect: INSERT,SELECT)'
SELECT COALESCE(string_agg(privilege_type, ',' ORDER BY privilege_type), '(none)') AS cerp_app_privs
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='hr_time_events' AND grantee='cerp_app';

\echo '### append-only triggers (expect 3)'
SELECT tgname FROM pg_trigger
WHERE tgrelid='public.hr_time_events'::regclass AND NOT tgisinternal
ORDER BY tgname;

\echo '### fixture: un user existant + un employé + un événement de test'
SELECT id AS uid FROM public.users ORDER BY id LIMIT 1 \gset
INSERT INTO public.hr_employees (user_id, matricule)
VALUES (:uid, 'HR_VERIFY')
ON CONFLICT (matricule) DO UPDATE SET updated_at = now()
RETURNING id AS emp_id \gset
INSERT INTO public.hr_time_events (employee_id, event_type, event_time, source)
VALUES (:'emp_id', 'IN', now(), 'ADMIN')
RETURNING id AS ev_id \gset

\echo '### [1] cerp_app INSERT — EXPECT SUCCESS'
SET ROLE cerp_app;
INSERT INTO public.hr_time_events (employee_id, event_type, event_time, source)
VALUES (:'emp_id', 'OUT', now(), 'WEB');

\echo '### [2] cerp_app UPDATE — EXPECT: permission denied'
UPDATE public.hr_time_events SET event_type='OUT' WHERE id = :'ev_id';

\echo '### [3] cerp_app DELETE — EXPECT: permission denied'
DELETE FROM public.hr_time_events WHERE id = :'ev_id';
RESET ROLE;

\echo '### [4] trigger backstop: UPDATE owner sur la vraie ligne — EXPECT append-only exception'
UPDATE public.hr_time_events SET event_type='OUT' WHERE id = :'ev_id';

\echo '### cleanup (superuser + replica) — retire la fixture'
SET session_replication_role='replica';
DELETE FROM public.hr_time_events WHERE employee_id = :'emp_id';
DELETE FROM public.hr_employees WHERE matricule='HR_VERIFY';
SET session_replication_role='origin';

\echo '### leftover fixture (expect 0)'
SELECT count(*) AS leftover FROM public.hr_employees WHERE matricule='HR_VERIFY';
