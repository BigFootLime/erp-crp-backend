DO $$
DECLARE
  missing_columns integer;
BEGIN
  SELECT count(*) INTO missing_columns
  FROM (VALUES
    ('commande_client', 'creation_flow_version'),
    ('commande_ligne', 'piece_technique_version_id'),
    ('commande_ligne', 'source_devis_ligne_id'),
    ('commande_ligne', 'reconciliation_status'),
    ('commande_ligne', 'reconciliation_sources'),
    ('commande_ligne', 'reconciliation_decisions'),
    ('commande_ligne', 'reconciliation_resolved_at'),
    ('commande_ligne', 'reconciliation_resolved_by')
  ) AS expected(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
  );

  IF missing_columns <> 0 THEN
    RAISE EXCEPTION '#698 schema verification failed: % columns missing', missing_columns;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ligne_piece_version_fkey')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ligne_source_devis_ligne_fkey')
     OR to_regclass('public.commande_ligne_piece_version_idx') IS NULL THEN
    RAISE EXCEPTION '#698 constraints or indexes are incomplete';
  END IF;
END $$;

SELECT
  count(*) FILTER (WHERE creation_flow_version = 1)::int AS legacy_commandes,
  count(*) FILTER (WHERE creation_flow_version = 2)::int AS reconciled_commandes
FROM public.commande_client;

