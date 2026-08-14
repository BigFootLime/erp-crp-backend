\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION 'PostgreSQL 14+ requis';
  END IF;
  IF to_regclass('public.project_projects') IS NULL THEN missing := array_append(missing, 'project_projects'); END IF;
  IF to_regclass('public.project_work_packages') IS NULL THEN missing := array_append(missing, 'project_work_packages'); END IF;
  IF to_regclass('public.project_milestones') IS NULL THEN missing := array_append(missing, 'project_milestones'); END IF;
  IF to_regclass('public.project_risks') IS NULL THEN missing := array_append(missing, 'project_risks'); END IF;
  IF to_regclass('public.affaire') IS NULL THEN missing := array_append(missing, 'affaire'); END IF;
  IF to_regclass('public.hr_employees') IS NULL THEN missing := array_append(missing, 'hr_employees'); END IF;
  IF to_regclass('public.hr_kilometer_entries') IS NULL THEN missing := array_append(missing, 'hr_kilometer_entries'); END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Prerequis SOL-24 manquants: %', array_to_string(missing, ', ');
  END IF;
END $$;

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT COUNT(*) FROM public.project_projects) AS projects,
       (SELECT COUNT(*) FROM public.affaire) AS affaires,
       (SELECT COUNT(*) FROM public.hr_employees) AS employees,
       (SELECT COUNT(*) FROM public.hr_kilometer_entries) AS kilometer_entries;

SELECT COUNT(*) AS duplicate_active_absence_candidates
FROM (
  SELECT employee_id, date, COUNT(*)
  FROM public.hr_timesheet_days
  GROUP BY employee_id, date
  HAVING COUNT(*) > 1
) d;
