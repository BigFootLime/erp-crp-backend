-- Lecture seule — prérequis des patches comptes/RBAC #315.
DO $$
DECLARE
  missing_columns text[];
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Unexpected database for #315: %', current_database();
  END IF;

  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite table public.users';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
  INTO missing_columns
  FROM (
    VALUES
      ('id'),
      ('role'),
      ('tel_no'),
      ('gender'),
      ('address'),
      ('lane'),
      ('house_no'),
      ('postcode'),
      ('date_of_birth'),
      ('social_security_number')
  ) AS required(column_name)
  LEFT JOIN information_schema.columns actual
    ON actual.table_schema = 'public'
   AND actual.table_name = 'users'
   AND actual.column_name = required.column_name
  WHERE actual.column_name IS NULL;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Missing public.users columns for #315: %', missing_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.users
    WHERE role IS NULL
       OR role <> ALL (
         ARRAY[
           'Directeur',
           'Employee',
           'Administrateur Systeme et Reseau',
           'Responsable Qualité',
           'Secretaire',
           'Responsable Programmation',
           'Responsable RH'
         ]::text[]
       )
  ) THEN
    RAISE EXCEPTION 'Unknown or null users.role value blocks deterministic #315 backfill';
  END IF;
END $$;

SELECT
  current_database() AS database_name,
  COUNT(*)::int AS user_count,
  COUNT(DISTINCT role)::int AS distinct_primary_roles
FROM public.users;
