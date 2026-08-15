\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  current_scale integer;
  proven_count integer;
BEGIN
  IF to_regclass('public.cerp_migration_supersessions') IS NULL THEN
    RAISE EXCEPTION 'SOL-43 convergence verification failed: supersession audit table is missing';
  END IF;

  IF to_regclass('public.contacts_client_email_identity_active_key') IS NULL
     OR to_regclass('public.contacts_email_key') IS NOT NULL
     OR to_regclass('public.contacts_client_email_active_key') IS NOT NULL THEN
    RAISE EXCEPTION 'SOL-43 convergence verification failed: contact identity indexes are not final';
  END IF;

  SELECT numeric_scale
    INTO current_scale
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'stock_movement_lines'
     AND column_name = 'qty';

  IF current_scale <> 6 THEN
    RAISE EXCEPTION 'SOL-43 convergence verification failed: stock quantity scale is %', current_scale;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.data_import_batches'::regclass
       AND conname = 'data_import_batches_entity_ck'
       AND pg_get_constraintdef(oid) LIKE '%FOURNISSEUR_COMMANDE%'
  ) THEN
    RAISE EXCEPTION 'SOL-43 convergence verification failed: supplier-order import is not allowed';
  END IF;

  IF to_regclass('public.client_contact_create_idempotency') IS NULL
     OR to_regclass('public.client_contact_create_idempotency_contact_idx') IS NULL THEN
    RAISE EXCEPTION 'SOL-43 convergence verification failed: contact idempotency state is missing';
  END IF;

  SELECT count(*)::integer
    INTO proven_count
    FROM public.cerp_schema_migrations AS applied
    JOIN public.cerp_migration_supersessions AS supersession
      ON supersession.legacy_filename = applied.filename
     AND supersession.legacy_sha256 = applied.sha256
   WHERE applied.filename IN (
     '20260727_contacts_email_scope_187.sql',
     '20260727_contacts_shared_email_identity_190.sql',
     '20260727_import_clients_enrichment_306.sql',
     '20260727_import_supplier_orders_312.sql',
     '20260727_stock_import_precision_198.sql'
   );

  IF proven_count <> 5 THEN
    RAISE EXCEPTION 'SOL-43 convergence verification failed: expected 5 provenance records, found %', proven_count;
  END IF;
END
$$;

COMMIT;
