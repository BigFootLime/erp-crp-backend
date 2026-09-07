-- User-authorized policy change: active account superadmins may approve their own GED deposits.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod') THEN
    RAISE EXCEPTION 'Unexpected database for GED approval policy';
  END IF;
  IF to_regprocedure('public.fn_ged_version_separation_of_duties()') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='is_superadmin') THEN
    RAISE EXCEPTION 'GED approval prerequisites are missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_ged_version_separation_of_duties()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE allowed_self_approval boolean := false;
BEGIN
  IF NEW.approved_by IS NOT NULL AND NEW.created_by IS NOT NULL
     AND NEW.approved_by = NEW.created_by THEN
    -- A later revocation does not invalidate an already frozen approval.
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status IN ('APPROUVE', 'APPLICABLE', 'OBSOLETE')
         AND OLD.approved_at IS NOT NULL
         AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by
         AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
        RETURN NEW;
      END IF;
    END IF;
    SELECT COALESCE(u.is_superadmin, false) AND u.status = 'Active'
      INTO allowed_self_approval FROM public.users u
      WHERE u.id = NEW.approved_by FOR SHARE;
    IF allowed_self_approval IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'GED_APPROVAL_SELF: seul un superutilisateur actif peut approuver son propre depot (version=%)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
