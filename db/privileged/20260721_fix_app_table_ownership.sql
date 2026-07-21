-- 20260721_fix_app_table_ownership.sql            (SUPERUSER / postgres peer-auth ONLY)
--
-- CONTEXT
--   Several application tables across modules were created by applying patches as the
--   OS `postgres` role (peer auth) instead of the cerp_app `db:patches` runner. They
--   ended up OWNED BY postgres, so the application role `cerp_app` received
--   "permission denied for table ..." (SQLSTATE 42501) and endpoints returned 500 —
--   notably GET /api/v1/fournisseurs/domaines. Affected on 2026-07-21 (cerp_prod +
--   cerp_test): the #163 fournisseur ecosystem/360 tables (fournisseur_domaines,
--   fournisseur_domaine_lien, fournisseur_outillage_mapping, fournisseur_events,
--   fournisseur_adresses, fournisseur_homologations, fournisseur_catalogue_prix_history),
--   the #162 client_create_idempotency, of_generation_batches, of_structure_snapshot,
--   and non_conformity_dispositions.
--
-- FIX
--   Give ownership of every public application table back to cerp_app, EXCEPT the two
--   deliberately append-only tables (erp_audit_logs, hr_time_events) which MUST stay
--   postgres-owned with only SELECT,INSERT granted to cerp_app — a table owner bypasses
--   REVOKE and can DISABLE TRIGGER, so immutability requires ownership off the app role
--   (see 20260707_erp_audit_logs_append_only.sql, 20260709_hr_time_events_append_only.sql).
--
-- PROPERTIES
--   Idempotent. Non-destructive (no row is inserted/updated/deleted). Re-runnable.
--
-- APPLY (cerp_test first, then cerp_prod after backup + explicit human authorization):
--   sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f db/privileged/20260721_fix_app_table_ownership.sql

BEGIN;

-- Part A — app tables/sequences wrongly owned by postgres -> cerp_app (skip append-only)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tableowner = 'postgres'
      AND tablename NOT IN ('erp_audit_logs', 'hr_time_events')
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', r.tablename);
    RAISE NOTICE 'owner -> cerp_app: %', r.tablename;
  END LOOP;

  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND pg_get_userbyid(c.relowner) = 'postgres'
      AND c.relname NOT IN ('erp_audit_logs_id_seq')
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO cerp_app', r.relname);
    RAISE NOTICE 'seq owner -> cerp_app: %', r.relname;
  END LOOP;
END $$;

-- Part B — re-assert the append-only design (owner postgres; cerp_app = SELECT,INSERT only)
DO $$
DECLARE t text; v_seq text;
BEGIN
  FOREACH t IN ARRAY ARRAY['erp_audit_logs', 'hr_time_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM cerp_app', t);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM PUBLIC', t);
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO cerp_app', t);
      SELECT pg_get_serial_sequence('public.' || t, 'id') INTO v_seq;
      IF v_seq IS NOT NULL THEN
        EXECUTE format('ALTER SEQUENCE %s OWNER TO postgres', v_seq);
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO cerp_app', v_seq);
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
