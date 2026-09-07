\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF current_database() NOT IN ('cerp_test','cerp_prod') THEN RAISE EXCEPTION 'Unexpected database'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ged_document_versions'::regclass AND tgname='trg_ged_version_separation_of_duties' AND tgenabled='O') THEN RAISE EXCEPTION 'GED policy trigger not enabled'; END IF;
END $$;
-- Isolated trigger tests: no GED document or user is created, updated or deleted.
CREATE TEMP TABLE ged_policy_758_probe (id uuid DEFAULT gen_random_uuid(), status text, approved_by int, created_by int, approved_at timestamptz) ON COMMIT DROP;
CREATE TRIGGER ged_policy_758_probe_trigger BEFORE INSERT OR UPDATE ON ged_policy_758_probe
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_version_separation_of_duties();
DO $$
DECLARE su int; ordinary int; row_id uuid;
BEGIN
  SELECT id INTO su FROM public.users WHERE is_superadmin=true AND status='Active' ORDER BY id LIMIT 1;
  SELECT id INTO ordinary FROM public.users WHERE COALESCE(is_superadmin,false)=false ORDER BY id LIMIT 1;
  IF su IS NULL OR ordinary IS NULL THEN RAISE EXCEPTION 'Missing accounts for policy verification'; END IF;
  BEGIN
    INSERT INTO ged_policy_758_probe(status,approved_by,created_by) VALUES('APPROUVE',ordinary,ordinary);
    RAISE EXCEPTION 'Ordinary self approval was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO ged_policy_758_probe(status,approved_by,created_by,approved_at) VALUES('APPROUVE',su,su,now());
  INSERT INTO ged_policy_758_probe(status,approved_by,created_by) VALUES('APPROUVE',su,ordinary);
  -- Simulate an already approved historical row after the account lost privilege.
  INSERT INTO ged_policy_758_probe(status,approved_by,created_by,approved_at) VALUES('APPROUVE',NULL,ordinary,now()) RETURNING id INTO row_id;
  ALTER TABLE ged_policy_758_probe DISABLE TRIGGER ged_policy_758_probe_trigger;
  UPDATE ged_policy_758_probe SET approved_by=ordinary WHERE id=row_id;
  ALTER TABLE ged_policy_758_probe ENABLE TRIGGER ged_policy_758_probe_trigger;
  UPDATE ged_policy_758_probe SET status='APPLICABLE' WHERE id=row_id;
  RAISE NOTICE 'GED #758: ordinary refused, active superadmin allowed, distinct approver allowed, frozen history preserved';
END $$;
ROLLBACK;
