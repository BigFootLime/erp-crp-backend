\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  current_scale integer;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'SOL-43 convergence preflight refused on database %', current_database();
  END IF;

  IF to_regclass('public.contacts') IS NULL
     OR to_regclass('public.data_import_batches') IS NULL
     OR to_regclass('public.stock_movement_lines') IS NULL
     OR to_regclass('public.stock_movements') IS NULL
     OR to_regclass('public.stock_movement_event_log') IS NULL
     OR to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'SOL-43 convergence preflight refused: required tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.contacts
     WHERE client_id IS NOT NULL
       AND email IS NOT NULL
       AND btrim(email) <> ''
       AND archived_at IS NULL
     GROUP BY client_id, lower(btrim(email)), lower(btrim(coalesce(first_name, ''))), lower(btrim(coalesce(last_name, '')))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SOL-43 convergence preflight refused: duplicate active contact identities exist';
  END IF;

  SELECT numeric_scale
    INTO current_scale
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'stock_movement_lines'
     AND column_name = 'qty';

  IF current_scale NOT IN (3, 6) THEN
    RAISE EXCEPTION 'SOL-43 convergence preflight refused: unexpected stock quantity scale %', current_scale;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.cerp_schema_migrations AS applied
      JOIN (VALUES
        ('20260727_contacts_email_scope_187.sql', '4d43141bc2e6b803f4b37d1dff146c9950e64c75f0b317194ebf03dacbddbf1a'),
        ('20260727_contacts_shared_email_identity_190.sql', 'b3b030cefbbf16ceca44481d74380de71803d72320c19b4da9cc62eee37aaf89'),
        ('20260727_import_clients_enrichment_306.sql', '3b0987397ad79f1fe8580c19a7cd2153c3ed5fb3617d357b2dfa452684b93181'),
        ('20260727_import_supplier_orders_312.sql', '5988f518ebfe8160372ec833fb14fba636a54638f367a637703162032d7193a0'),
        ('20260727_stock_import_precision_198.sql', '0a348b7d6b723ba2d38b4927a5eed9a3999e3dfa82f56940f1f3a4d5b2da5a6a')
      ) AS expected(filename, sha256)
        ON expected.filename = applied.filename
     WHERE applied.sha256 <> expected.sha256
  ) THEN
    RAISE EXCEPTION 'SOL-43 convergence preflight refused: historical migration checksum mismatch';
  END IF;
END
$$;

COMMIT;
