-- Read-only prerequisites; this check does not activate or reset a counter.
SELECT current_database() AS database_name,
       to_regclass('public.users') IS NOT NULL AS users_present,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') AS application_role_present;
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Numbering preparation requires public.users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    RAISE EXCEPTION 'Numbering preparation requires the cerp_app application role';
  END IF;
END $$;
