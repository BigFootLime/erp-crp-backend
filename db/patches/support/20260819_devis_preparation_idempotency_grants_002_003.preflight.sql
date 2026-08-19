\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $guard$
DECLARE
  target_relation text;
  required_column record;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-AUDIT-002/003 grant preflight refused on database %', current_database();
  END IF;
  FOREACH target_relation IN ARRAY ARRAY[
    'public.article_devis',
    'public.dossier_technique_piece_devis',
    'public.devis_idempotence'
  ] LOOP
    IF to_regclass(target_relation) IS NULL THEN
      RAISE EXCEPTION 'CERP-AUDIT-002/003 grant preflight refused: relation % is missing', target_relation;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-AUDIT-002/003 grant preflight refused: runtime role cerp_app is missing';
  END IF;

  FOR required_column IN
    SELECT * FROM (VALUES
      ('devis', 'root_devis_id'),
      ('devis', 'parent_devis_id'),
      ('devis', 'version_number'),
      ('devis', 'conditions_paiement_id'),
      ('devis', 'compte_vente_id'),
      ('devis', 'biller_id'),
      ('devis_ligne', 'position')
    ) AS expected(table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = required_column.table_name
        AND column_name = required_column.column_name
    ) THEN
      RAISE EXCEPTION 'CERP-AUDIT-002/003 grant preflight refused: missing %.%',
        required_column.table_name, required_column.column_name;
    END IF;
  END LOOP;
END
$guard$;

-- Evidence only: these are expected to be false before this corrective patch.
SELECT relation,
       has_table_privilege('cerp_app', relation, 'SELECT') AS can_select,
       has_table_privilege('cerp_app', relation, 'INSERT') AS can_insert,
       has_table_privilege('cerp_app', relation, 'DELETE') AS can_delete
FROM unnest(ARRAY[
  'public.article_devis',
  'public.dossier_technique_piece_devis',
  'public.devis_idempotence'
]) AS relation;

COMMIT;
