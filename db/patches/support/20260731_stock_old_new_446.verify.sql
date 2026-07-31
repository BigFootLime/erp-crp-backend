\set ON_ERROR_STOP on

-- #446 verification. It performs catalog/data checks only and never writes.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;

DO $$
DECLARE
  v_fixed_store_count integer;
  v_required_magasin_columns integer;
BEGIN
  IF to_regclass('public.stock_lot_trace_references') IS NULL
     OR to_regclass('public.stock_trace_code_446_seq') IS NULL THEN
    RAISE EXCEPTION '#446 verify failed: trace reference table or sequence is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses'
      AND column_name = 'stock_scope' AND data_type = 'text'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'magasins'
      AND column_name = 'stock_scope' AND data_type = 'text'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lots'
      AND column_name IN ('stock_trace_code', 'qr_payload', 'origin_stock_scope')
    GROUP BY table_name HAVING count(*) = 3
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'articles_achat'
      AND column_name IN ('reference_client', 'indice_client', 'numero_client')
    GROUP BY table_name HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION '#446 verify failed: expected OLD/NEW or lot-trace columns are missing';
  END IF;

  IF (SELECT count(*) FROM public.article_category_ref
      WHERE code = 'achat_transforme' AND label = 'Fourniture Client') <> 1 THEN
    RAISE EXCEPTION '#446 verify failed: achat_transforme must be labelled Fourniture Client';
  END IF;

  SELECT count(*) INTO v_required_magasin_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'magasins'
    AND (
      (column_name IN ('code_magasin', 'libelle')
       AND data_type = 'character varying' AND is_nullable = 'NO')
      OR (column_name = 'actif' AND data_type = 'boolean')
    );
  IF v_required_magasin_columns <> 3 THEN
    RAISE EXCEPTION '#446 verify failed: required legacy magasin columns are missing or incompatible';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_stock_scope_446_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'magasins_stock_scope_446_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_origin_stock_scope_446_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_stock_trace_code_446_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_qr_payload_446_ck') THEN
    RAISE EXCEPTION '#446 verify failed: one or more OLD/NEW trace constraints are missing';
  END IF;

  SELECT count(*) INTO v_fixed_store_count
  FROM (
    VALUES
      ('OLD-PF', 'Base old - Produits finis', 'OLD'),
      ('OLD-MP', 'Base old - Matieres premieres', 'OLD'),
      ('NEW-PF', 'Base new - Produits finis', 'NEW'),
      ('NEW-MP', 'Base new - Matieres premieres', 'NEW')
  ) AS expected(code, name, stock_scope)
  JOIN public.warehouses warehouse
    ON warehouse.code = expected.code AND warehouse.stock_scope = expected.stock_scope
  JOIN public.magasins magasin
   ON magasin.code = expected.code
   AND magasin.code_magasin = expected.code
   AND magasin.name = expected.name
   AND magasin.libelle = expected.name
   AND magasin.stock_scope = expected.stock_scope
   AND magasin.warehouse_id = warehouse.id
   AND magasin.is_active
   AND magasin.actif;

  IF v_fixed_store_count <> 4 THEN
    RAISE EXCEPTION '#446 verify failed: expected four aligned OLD/NEW warehouses and magasins, found %', v_fixed_store_count;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
     AND (
       NOT has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'SELECT')
       OR NOT has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'INSERT')
       OR NOT has_sequence_privilege('cerp_app', 'public.stock_trace_code_446_seq', 'USAGE')
       OR NOT has_sequence_privilege('cerp_app', 'public.stock_trace_code_446_seq', 'SELECT')
     ) THEN
    RAISE EXCEPTION '#446 verify failed: cerp_app lacks required #446 runtime grants';
  END IF;
END $$;

SELECT
  constraint_name,
  constraint_type,
  is_deferrable,
  initially_deferred
FROM information_schema.table_constraints
WHERE constraint_schema = 'public'
  AND constraint_name IN (
    'warehouses_stock_scope_446_ck',
    'magasins_stock_scope_446_ck',
    'lots_origin_stock_scope_446_ck',
    'lots_stock_trace_code_446_ck',
    'lots_qr_payload_446_ck',
    'stock_lot_trace_references_type_446_ck',
    'stock_lot_trace_references_value_446_ck',
    'stock_lot_trace_references_446_uq'
  )
ORDER BY constraint_name;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'warehouses_stock_scope_446_idx',
    'magasins_stock_scope_446_idx',
    'lots_stock_trace_code_446_uq',
    'stock_lot_trace_references_lot_446_idx'
  )
ORDER BY indexname;

SELECT
  expected.code,
  expected.name,
  expected.stock_scope,
  warehouse.id AS warehouse_id,
  magasin.id AS magasin_id,
  magasin.code_magasin,
  magasin.libelle,
  magasin.is_active,
  magasin.actif
FROM (
  VALUES
    ('OLD-PF', 'Base old - Produits finis', 'OLD'),
    ('OLD-MP', 'Base old - Matieres premieres', 'OLD'),
    ('NEW-PF', 'Base new - Produits finis', 'NEW'),
    ('NEW-MP', 'Base new - Matieres premieres', 'NEW')
) AS expected(code, name, stock_scope)
JOIN public.warehouses warehouse
  ON warehouse.code = expected.code
JOIN public.magasins magasin
  ON magasin.code = expected.code
 AND magasin.code_magasin = expected.code
 AND magasin.name = expected.name
 AND magasin.libelle = expected.name
ORDER BY expected.code;

SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    THEN has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'SELECT')
      AND has_table_privilege('cerp_app', 'public.stock_lot_trace_references', 'INSERT')
    ELSE NULL
  END AS cerp_app_trace_reference_access,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    THEN has_sequence_privilege('cerp_app', 'public.stock_trace_code_446_seq', 'USAGE')
      AND has_sequence_privilege('cerp_app', 'public.stock_trace_code_446_seq', 'SELECT')
    ELSE NULL
  END AS cerp_app_trace_sequence_access;

COMMIT;
