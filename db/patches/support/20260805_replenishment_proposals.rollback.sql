\set ON_ERROR_STOP on

-- Destructive schema rollback is dev/test-only. It removes only the exact
-- artifacts proven to belong to this migration and deletes the matching ledger
-- row in the same transaction so the canonical runner can reapply the patch.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

DO $environment_guard$
BEGIN
  IF current_database() NOT IN ('cerp_dev', 'cerp_test') THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback is restricted to cerp_dev/cerp_test';
  END IF;
END
$environment_guard$;

SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'));

DO $rollback$
DECLARE
  expected_sha256 constant text := 'ff54b540e49cb855b74bdc150304e8ebfaf0322c3c4b0e6dbfcf9c71cd2f983a';
  registered_sha256 text;
  registered_applied_at timestamptz;
  registry_entry_exists boolean := false;
  target_table_count integer;
  target_function_count integer;
  target_column_count integer;
  target_constraint_count integer;
  target_index_count integer;
  target_trigger_count integer;
  module_prefix_count integer;
  owner_count integer;
  acl_count integer;
  actual_count integer;
  evidence_count bigint;
  changed_rows integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: migration registry is missing';
  END IF;
  IF to_regclass('public.app_modules') IS NULL OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: module catalogue or runtime role is missing';
  END IF;

  SELECT sha256, applied_at INTO registered_sha256, registered_applied_at
  FROM public.cerp_schema_migrations
  WHERE filename = '20260805_replenishment_proposals.sql'
  FOR UPDATE;
  registry_entry_exists := FOUND;

  SELECT COUNT(*)::integer INTO target_table_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname = ANY (ARRAY[
      'replenishment_budgets','replenishment_proposals',
      'replenishment_proposal_events','replenishment_proposal_idempotence'
    ]);
  SELECT COUNT(*)::integer INTO target_function_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_replenishment_event_immutable'
    AND p.pronargs = 0;
  SELECT COUNT(*)::integer INTO target_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND (
    (table_name = 'stock_levels' AND column_name IN ('safety_stock_qty','target_stock_qty','order_lot_size'))
    OR (table_name = 'fournisseur_catalogue' AND column_name IN ('unite_stock','coef_conversion','lot_achat'))
    OR (table_name = 'commande_fournisseur' AND column_name = 'replenishment_proposal_id')
  );
  SELECT COUNT(*)::integer INTO target_constraint_count
  FROM pg_constraint WHERE conname = ANY (ARRAY[
    'stock_levels_replenishment_qty_chk','fournisseur_catalogue_conversion_chk',
    'commande_fournisseur_replenishment_fkey',
    'replenishment_budgets_pkey','replenishment_budgets_magasin_id_fkey',
    'replenishment_budgets_values_chk','replenishment_budgets_scope_uniq',
    'replenishment_proposals_pkey','replenishment_proposals_article_id_fkey',
    'replenishment_proposals_magasin_id_fkey','replenishment_proposals_selected_catalogue_id_fkey',
    'replenishment_proposals_selected_supplier_id_fkey',
    'replenishment_proposals_commande_fournisseur_id_fkey',
    'replenishment_proposals_commande_fournisseur_ligne_id_fkey',
    'replenishment_proposals_status_chk','replenishment_proposals_budget_chk',
    'replenishment_proposals_values_chk','replenishment_proposal_events_pkey',
    'replenishment_proposal_events_proposal_id_fkey','replenishment_proposal_idempotence_pkey',
    'replenishment_proposal_idempotence_proposal_id_fkey','replenishment_proposal_idem_uniq',
    'replenishment_proposal_idem_key_chk','replenishment_proposal_idem_hash_chk'
  ]);
  SELECT COUNT(*)::integer INTO target_index_count
  FROM pg_class WHERE relkind = 'i' AND relname = ANY (ARRAY[
    'commande_fournisseur_replenishment_idx','replenishment_budgets_pkey',
    'replenishment_budgets_scope_uniq','replenishment_proposals_pkey','replenishment_proposals_status_idx',
    'replenishment_proposals_article_site_uniq','replenishment_proposals_article_unmapped_uniq',
    'replenishment_proposal_events_pkey','replenishment_proposal_events_proposal_idx',
    'replenishment_proposal_idempotence_pkey','replenishment_proposal_idem_uniq'
  ]);
  SELECT COUNT(*)::integer INTO module_prefix_count
  FROM public.app_modules m, unnest(m.api_prefixes) AS prefix
  WHERE m.module_key = 'commandes-fournisseurs' AND prefix = '/replenishment-proposals';

  IF NOT registry_entry_exists THEN
    IF target_table_count = 0 AND target_function_count = 0 AND target_column_count = 0
       AND target_constraint_count = 0 AND target_index_count = 0 AND module_prefix_count = 0 THEN
      RAISE NOTICE 'FEAT-CERP-0003 rollback: exact artifacts already absent';
      RETURN;
    END IF;
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: artifacts exist without migration ledger provenance';
  END IF;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: migration ledger provenance is invalid';
  END IF;
  IF target_table_count <> 4 OR target_function_count <> 1 OR target_column_count <> 7
     OR target_constraint_count <> 24 OR target_index_count <> 11 OR module_prefix_count <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target artifacts or ledger are in a partial state';
  END IF;

  LOCK TABLE public.app_modules,
    public.stock_levels,
    public.fournisseur_catalogue,
    public.commande_fournisseur,
    public.replenishment_budgets,
    public.replenishment_proposals,
    public.replenishment_proposal_events,
    public.replenishment_proposal_idempotence
  IN ACCESS EXCLUSIVE MODE;

  SELECT COUNT(*)::integer INTO target_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = ANY (ARRAY[
      'replenishment_budgets','replenishment_proposals',
      'replenishment_proposal_events','replenishment_proposal_idempotence'
    ]);
  IF target_column_count <> 66 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target table columns are incomplete or additional';
  END IF;

  SELECT COUNT(*)::integer INTO target_constraint_count
  FROM pg_constraint
  WHERE conrelid = ANY (ARRAY[
    'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
  ]) AND convalidated AND conname = ANY (ARRAY[
    'replenishment_budgets_pkey','replenishment_budgets_magasin_id_fkey',
    'replenishment_budgets_values_chk','replenishment_budgets_scope_uniq',
    'replenishment_proposals_pkey','replenishment_proposals_article_id_fkey',
    'replenishment_proposals_magasin_id_fkey','replenishment_proposals_selected_catalogue_id_fkey',
    'replenishment_proposals_selected_supplier_id_fkey',
    'replenishment_proposals_commande_fournisseur_id_fkey',
    'replenishment_proposals_commande_fournisseur_ligne_id_fkey',
    'replenishment_proposals_status_chk','replenishment_proposals_budget_chk',
    'replenishment_proposals_values_chk','replenishment_proposal_events_pkey',
    'replenishment_proposal_events_proposal_id_fkey','replenishment_proposal_idempotence_pkey',
    'replenishment_proposal_idempotence_proposal_id_fkey','replenishment_proposal_idem_uniq',
    'replenishment_proposal_idem_key_chk','replenishment_proposal_idem_hash_chk'
  ]);
  IF target_constraint_count <> 21 OR (
    SELECT COUNT(*) FROM pg_constraint WHERE conrelid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ])
  ) <> 21 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target constraints are altered or additional';
  END IF;

  SELECT COUNT(*)::integer INTO target_index_count
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = ANY (ARRAY[
    'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
  ]) AND c.relname = ANY (ARRAY[
    'replenishment_budgets_pkey','replenishment_budgets_scope_uniq',
    'replenishment_proposals_pkey','replenishment_proposals_status_idx',
    'replenishment_proposals_article_site_uniq','replenishment_proposals_article_unmapped_uniq',
    'replenishment_proposal_events_pkey','replenishment_proposal_events_proposal_idx',
    'replenishment_proposal_idempotence_pkey','replenishment_proposal_idem_uniq'
  ]);
  IF target_index_count <> 10 OR (
    SELECT COUNT(*) FROM pg_index WHERE indrelid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ])
  ) <> 10 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target indexes are altered or additional';
  END IF;

  SELECT COUNT(*)::integer INTO target_trigger_count
  FROM pg_trigger
  WHERE NOT tgisinternal AND tgenabled = 'O'
    AND tgrelid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ]) AND tgname = ANY (ARRAY[
      'replenishment_proposal_events_immutable','replenishment_proposals_set_updated_at',
      'replenishment_budgets_set_updated_at'
    ]);
  IF target_trigger_count <> 3 OR (
    SELECT COUNT(*) FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ])
  ) <> 3 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target triggers are altered, disabled, or additional';
  END IF;

  SELECT COUNT(*)::integer INTO owner_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY (ARRAY[
      'replenishment_budgets','replenishment_proposals',
      'replenishment_proposal_events','replenishment_proposal_idempotence'
    ]) AND c.relowner = to_regrole('cerp_app');
  IF owner_count <> 4 OR (
    SELECT proowner FROM pg_proc
    WHERE oid = 'public.fn_replenishment_event_immutable()'::regprocedure
  ) IS DISTINCT FROM to_regrole('cerp_app') THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target ownership is unexpected';
  END IF;

  SELECT COUNT(*)::integer INTO acl_count
  FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
  WHERE c.oid = ANY (ARRAY[
    'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
  ]) AND acl.grantor = to_regrole('cerp_app') AND acl.grantee = to_regrole('cerp_app') AND NOT acl.is_grantable
    AND ((c.relname IN ('replenishment_budgets','replenishment_proposals') AND acl.privilege_type IN ('SELECT','INSERT','UPDATE'))
      OR (c.relname IN ('replenishment_proposal_events','replenishment_proposal_idempotence') AND acl.privilege_type IN ('SELECT','INSERT')));
  IF acl_count <> 10 OR EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ]) AND (acl.grantee <> to_regrole('cerp_app') OR acl.is_grantable
      OR (c.relname IN ('replenishment_budgets','replenishment_proposals') AND acl.privilege_type NOT IN ('SELECT','INSERT','UPDATE'))
      OR (c.relname IN ('replenishment_proposal_events','replenishment_proposal_idempotence') AND acl.privilege_type NOT IN ('SELECT','INSERT')))
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target table ACL is unexpected';
  END IF;

  SELECT COUNT(*)::integer INTO acl_count
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  WHERE p.oid = 'public.fn_replenishment_event_immutable()'::regprocedure
    AND acl.grantor = to_regrole('cerp_app') AND acl.grantee = to_regrole('cerp_app')
    AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable;
  IF acl_count <> 1 OR EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.fn_replenishment_event_immutable()'::regprocedure
      AND (acl.grantee <> to_regrole('cerp_app') OR acl.privilege_type <> 'EXECUTE' OR acl.is_grantable)
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: target function ACL is unexpected';
  END IF;

  -- Destructive DDL is allowed only while catalog definitions still match the
  -- exact objects created by this patch; same-named replacements are refused.
  WITH expected(relname, signature) AS (VALUES
    ('replenishment_budgets','528a64d4e7fa553f0f5d71f47ce80c00'),
    ('replenishment_proposals','89d363177e4f65d5a58c7deb09b3ecf5'),
    ('replenishment_proposal_events','bf8191942108d66226df3a844dbac83e'),
    ('replenishment_proposal_idempotence','73073d375a6c673616a608d479a0085d')
  ), actual AS (
    SELECT c.relname, md5(string_agg(format('%s|%s|%s|%s|%s|%s', a.attnum, a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull,
      coalesce(pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity), E'\n' ORDER BY a.attnum)) AS signature
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname IN (SELECT relname FROM expected)
      AND a.attnum > 0 AND NOT a.attisdropped
    GROUP BY c.relname
  ) SELECT COUNT(*) INTO actual_count FROM expected e JOIN actual a USING (relname)
      WHERE e.signature = a.signature;
  IF actual_count <> 4 THEN RAISE EXCEPTION 'FEAT-CERP-0003 rollback: full target column shape is altered'; END IF;

  WITH expected(relname, signature) AS (VALUES
    ('commande_fournisseur','ff186f775244f355e43241b53f7b1e11'),('fournisseur_catalogue','2cae272d52d3b409aea319cbeb8cb79d'),
    ('replenishment_budgets','f9d2132bf7f6961c4218e49666b1ec7c'),('replenishment_proposal_events','d000474beb2f6b3fcaf815188e8ae575'),
    ('replenishment_proposal_idempotence','3e1781cf5bf3d6c81c23576dfb83d0cf'),('replenishment_proposals','b51eb5fbdf7c26cf7b0e5c8b5a846042'),
    ('stock_levels','471249431c3f1c61764259ab31e524a6')
  ), actual AS (
    SELECT conrelid::regclass::text AS relname, md5(string_agg(format('%s|%s|%s', conname, contype,
      regexp_replace(pg_get_constraintdef(oid), '\s+', ' ', 'g')), E'\n' ORDER BY conname)) AS signature
    FROM pg_constraint WHERE conname = ANY (ARRAY[
      'stock_levels_replenishment_qty_chk','fournisseur_catalogue_conversion_chk','commande_fournisseur_replenishment_fkey',
      'replenishment_budgets_pkey','replenishment_budgets_magasin_id_fkey','replenishment_budgets_values_chk','replenishment_budgets_scope_uniq',
      'replenishment_proposals_pkey','replenishment_proposals_article_id_fkey','replenishment_proposals_magasin_id_fkey','replenishment_proposals_selected_catalogue_id_fkey','replenishment_proposals_selected_supplier_id_fkey','replenishment_proposals_commande_fournisseur_id_fkey','replenishment_proposals_commande_fournisseur_ligne_id_fkey','replenishment_proposals_status_chk','replenishment_proposals_budget_chk','replenishment_proposals_values_chk','replenishment_proposal_events_pkey','replenishment_proposal_events_proposal_id_fkey','replenishment_proposal_idempotence_pkey','replenishment_proposal_idempotence_proposal_id_fkey','replenishment_proposal_idem_uniq','replenishment_proposal_idem_key_chk','replenishment_proposal_idem_hash_chk'
    ]) GROUP BY conrelid
  ) SELECT COUNT(*) INTO actual_count FROM expected e JOIN actual a USING (relname) WHERE e.signature = a.signature;
  IF actual_count <> 7 THEN RAISE EXCEPTION 'FEAT-CERP-0003 rollback: owned constraint definition is altered'; END IF;

  WITH expected(relname, signature) AS (VALUES
    ('commande_fournisseur','b158333753277d57e9ecf7dd9df2c3fb'),('replenishment_budgets','e54643077ceba4240c065f3afdc69953'),
    ('replenishment_proposal_events','a55096cdc9603c72780a71651fabc465'),('replenishment_proposal_idempotence','df3cda198e42959304c28f97261291c4'),
    ('replenishment_proposals','793e25cd95c988147fe30ec37f0ab2ea')
  ), actual AS (
    SELECT i.indrelid::regclass::text AS relname, md5(string_agg(format('%s|%s|%s|%s|%s', c.relname, i.indisunique, i.indisprimary, i.indnkeyatts,
      regexp_replace(pg_get_indexdef(i.indexrelid), '\s+', ' ', 'g')), E'\n' ORDER BY c.relname)) AS signature
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = ANY (ARRAY['commande_fournisseur_replenishment_idx','replenishment_budgets_pkey','replenishment_budgets_scope_uniq','replenishment_proposals_pkey','replenishment_proposals_status_idx','replenishment_proposals_article_site_uniq','replenishment_proposals_article_unmapped_uniq','replenishment_proposal_events_pkey','replenishment_proposal_events_proposal_idx','replenishment_proposal_idempotence_pkey','replenishment_proposal_idem_uniq'])
    GROUP BY i.indrelid
  ) SELECT COUNT(*) INTO actual_count FROM expected e JOIN actual a USING (relname) WHERE e.signature = a.signature;
  IF actual_count <> 5 THEN RAISE EXCEPTION 'FEAT-CERP-0003 rollback: owned index definition is altered'; END IF;

  SELECT md5(string_agg(format('%s|%s|%s|%s|%s', tgname, tgtype, tgenabled, tgfoid::regprocedure, encode(tgargs, 'escape')), E'\n' ORDER BY tgname))
    INTO registered_sha256 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY (ARRAY['public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass]);
  IF registered_sha256 IS DISTINCT FROM '7e574b34d6c795630b9c08be2d6aded2' THEN RAISE EXCEPTION 'FEAT-CERP-0003 rollback: owned trigger mapping/event is altered'; END IF;
  SELECT md5(format('%s|%s|%s|%s|%s|%s', pg_get_functiondef(p.oid), p.provolatile, p.proisstrict, p.prosecdef, p.proleakproof, coalesce(array_to_string(p.proconfig, E'\n'), '')))
    INTO registered_sha256 FROM pg_proc p WHERE p.oid = 'public.fn_replenishment_event_immutable()'::regprocedure;
  IF registered_sha256 IS DISTINCT FROM '0e1298dced0e423190dfa3dc059ab371' THEN RAISE EXCEPTION 'FEAT-CERP-0003 rollback: immutable function definition/settings are altered'; END IF;

  SELECT (
    (SELECT COUNT(*) FROM public.replenishment_budgets)
    + (SELECT COUNT(*) FROM public.replenishment_proposals)
    + (SELECT COUNT(*) FROM public.replenishment_proposal_events)
    + (SELECT COUNT(*) FROM public.replenishment_proposal_idempotence)
    + (SELECT COUNT(*) FROM public.commande_fournisseur WHERE replenishment_proposal_id IS NOT NULL)
    + (SELECT COUNT(*) FROM public.stock_levels
       WHERE safety_stock_qty IS NOT NULL OR target_stock_qty IS NOT NULL OR order_lot_size IS NOT NULL)
    + (SELECT COUNT(*) FROM public.fournisseur_catalogue
       WHERE unite_stock IS NOT NULL OR coef_conversion IS NOT NULL OR lot_achat IS NOT NULL)
  )::bigint INTO evidence_count;
  IF evidence_count <> 0 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: replenishment evidence or governed values exist';
  END IF;

  EXECUTE 'DROP TRIGGER replenishment_proposal_events_immutable ON public.replenishment_proposal_events';
  EXECUTE 'DROP TRIGGER replenishment_proposals_set_updated_at ON public.replenishment_proposals';
  EXECUTE 'DROP TRIGGER replenishment_budgets_set_updated_at ON public.replenishment_budgets';
  EXECUTE 'DROP FUNCTION public.fn_replenishment_event_immutable()';

  EXECUTE 'ALTER TABLE public.commande_fournisseur DROP CONSTRAINT commande_fournisseur_replenishment_fkey';
  EXECUTE 'DROP INDEX public.commande_fournisseur_replenishment_idx';
  EXECUTE 'ALTER TABLE public.commande_fournisseur DROP COLUMN replenishment_proposal_id';
  EXECUTE 'DROP TABLE public.replenishment_proposal_idempotence';
  EXECUTE 'DROP TABLE public.replenishment_proposal_events';
  EXECUTE 'DROP TABLE public.replenishment_proposals';
  EXECUTE 'DROP TABLE public.replenishment_budgets';

  EXECUTE 'ALTER TABLE public.fournisseur_catalogue DROP CONSTRAINT fournisseur_catalogue_conversion_chk';
  EXECUTE 'ALTER TABLE public.fournisseur_catalogue DROP COLUMN lot_achat, DROP COLUMN coef_conversion, DROP COLUMN unite_stock';
  EXECUTE 'ALTER TABLE public.stock_levels DROP CONSTRAINT stock_levels_replenishment_qty_chk';
  EXECUTE 'ALTER TABLE public.stock_levels DROP COLUMN order_lot_size, DROP COLUMN target_stock_qty, DROP COLUMN safety_stock_qty';

  UPDATE public.app_modules
     SET api_prefixes = array_remove(api_prefixes, '/replenishment-proposals'),
         updated_at = now()
   WHERE module_key = 'commandes-fournisseurs'
     AND '/replenishment-proposals' = ANY(api_prefixes);
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: exact module prefix was not removed';
  END IF;

  DELETE FROM public.cerp_schema_migrations
  WHERE filename = '20260805_replenishment_proposals.sql'
    AND sha256 = expected_sha256;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: exact migration ledger row was not removed';
  END IF;

  IF to_regclass('public.replenishment_budgets') IS NOT NULL
     OR to_regclass('public.replenishment_proposals') IS NOT NULL
     OR to_regclass('public.replenishment_proposal_events') IS NOT NULL
     OR to_regclass('public.replenishment_proposal_idempotence') IS NOT NULL
     OR to_regprocedure('public.fn_replenishment_event_immutable()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.cerp_schema_migrations
       WHERE filename = '20260805_replenishment_proposals.sql'
     ) OR EXISTS (
       SELECT 1 FROM public.app_modules m, unnest(m.api_prefixes) AS prefix
       WHERE m.module_key = 'commandes-fournisseurs' AND prefix = '/replenishment-proposals'
     ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback: an owned artifact remains after rollback';
  END IF;
END
$rollback$;

COMMIT;
