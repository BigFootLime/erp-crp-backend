\set ON_ERROR_STOP on

-- Blocking post-apply verification. It validates registry provenance, exact
-- shape, active triggers, module routing, ownership, and explicit ACLs.
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  expected_sha256 constant text := 'ff54b540e49cb855b74bdc150304e8ebfaf0322c3c4b0e6dbfcf9c71cd2f983a';
  registered_sha256 text;
  registered_applied_at timestamptz;
  actual_count integer;
  expected_count integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: migration registry is missing';
  END IF;
  SELECT sha256, applied_at INTO registered_sha256, registered_applied_at
  FROM public.cerp_schema_migrations
  WHERE filename = '20260805_replenishment_proposals.sql';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: migration registry entry is missing';
  END IF;
  IF registered_sha256 IS DISTINCT FROM expected_sha256 OR registered_applied_at IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: migration ledger provenance is invalid';
  END IF;
  IF to_regrole('cerp_app') IS NULL OR to_regclass('public.app_modules') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: runtime role or module catalogue is missing';
  END IF;
  IF to_regclass('public.replenishment_budgets') IS NULL
     OR to_regclass('public.replenishment_proposals') IS NULL
     OR to_regclass('public.replenishment_proposal_events') IS NULL
     OR to_regclass('public.replenishment_proposal_idempotence') IS NULL
     OR to_regprocedure('public.fn_replenishment_event_immutable()') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: target table or function is missing';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE (table_name || '.' || column_name) = ANY (ARRAY[
           'replenishment_budgets.id','replenishment_budgets.magasin_id','replenishment_budgets.currency',
           'replenishment_budgets.period_start','replenishment_budgets.period_end','replenishment_budgets.amount_limit',
           'replenishment_budgets.active','replenishment_budgets.created_at','replenishment_budgets.updated_at',
           'replenishment_budgets.created_by','replenishment_budgets.updated_by',
           'replenishment_proposals.id','replenishment_proposals.stock_level_ids','replenishment_proposals.article_id',
           'replenishment_proposals.magasin_id','replenishment_proposals.status','replenishment_proposals.version',
           'replenishment_proposals.reason_code','replenishment_proposals.stock_unit','replenishment_proposals.qty_on_hand',
           'replenishment_proposals.qty_reserved','replenishment_proposals.qty_available','replenishment_proposals.qty_open_orders',
           'replenishment_proposals.minimum_stock_qty','replenishment_proposals.safety_stock_qty',
           'replenishment_proposals.target_stock_qty','replenishment_proposals.net_requirement_qty',
           'replenishment_proposals.selected_catalogue_id','replenishment_proposals.selected_supplier_id',
           'replenishment_proposals.purchase_unit','replenishment_proposals.stock_units_per_purchase_unit',
           'replenishment_proposals.proposed_purchase_qty','replenishment_proposals.proposed_stock_qty',
           'replenishment_proposals.unit_price','replenishment_proposals.currency','replenishment_proposals.estimated_total',
           'replenishment_proposals.budget_status','replenishment_proposals.budget_remaining',
           'replenishment_proposals.missing_data','replenishment_proposals.warnings','replenishment_proposals.calculation',
           'replenishment_proposals.commande_fournisseur_id','replenishment_proposals.commande_fournisseur_ligne_id',
           'replenishment_proposals.generated_at','replenishment_proposals.last_recalculated_at',
           'replenishment_proposals.validated_at','replenishment_proposals.validated_by',
           'replenishment_proposals.resolution_reason','replenishment_proposals.created_at','replenishment_proposals.updated_at',
           'replenishment_proposal_events.id','replenishment_proposal_events.proposal_id',
           'replenishment_proposal_events.event_type','replenishment_proposal_events.from_status',
           'replenishment_proposal_events.to_status','replenishment_proposal_events.calculation',
           'replenishment_proposal_events.details','replenishment_proposal_events.actor_id',
           'replenishment_proposal_events.created_at','replenishment_proposal_idempotence.id',
           'replenishment_proposal_idempotence.actor_id','replenishment_proposal_idempotence.idempotency_key',
           'replenishment_proposal_idempotence.request_hash','replenishment_proposal_idempotence.proposal_id',
           'replenishment_proposal_idempotence.result','replenishment_proposal_idempotence.created_at'
         ]))::integer
    INTO actual_count, expected_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = ANY (ARRAY[
      'replenishment_budgets','replenishment_proposals',
      'replenishment_proposal_events','replenishment_proposal_idempotence'
    ]);
  IF actual_count <> 66 OR expected_count <> 66 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: target columns are incomplete or additional';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE
           (table_name = 'stock_levels' AND column_name IN ('safety_stock_qty','target_stock_qty','order_lot_size')
             AND data_type = 'numeric' AND numeric_precision = 18 AND numeric_scale = 3 AND is_nullable = 'YES')
           OR (table_name = 'fournisseur_catalogue' AND column_name = 'unite_stock'
             AND data_type = 'text' AND is_nullable = 'YES')
           OR (table_name = 'fournisseur_catalogue' AND column_name = 'coef_conversion'
             AND data_type = 'numeric' AND numeric_precision = 18 AND numeric_scale = 6 AND is_nullable = 'YES')
           OR (table_name = 'fournisseur_catalogue' AND column_name = 'lot_achat'
             AND data_type = 'numeric' AND numeric_precision = 18 AND numeric_scale = 3 AND is_nullable = 'YES')
           OR (table_name = 'commande_fournisseur' AND column_name = 'replenishment_proposal_id'
             AND data_type = 'uuid' AND is_nullable = 'YES'))::integer
    INTO actual_count, expected_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'stock_levels' AND column_name IN ('safety_stock_qty','target_stock_qty','order_lot_size'))
      OR (table_name = 'fournisseur_catalogue' AND column_name IN ('unite_stock','coef_conversion','lot_achat'))
      OR (table_name = 'commande_fournisseur' AND column_name = 'replenishment_proposal_id')
    );
  IF actual_count <> 7 OR expected_count <> 7 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: added columns have unexpected types or nullability';
  END IF;
  IF (SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replenishment_proposals'
        AND column_name = 'stock_level_ids') IS DISTINCT FROM '_uuid' THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: stock_level_ids is not uuid[]';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE conname = ANY (ARRAY[
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
         ]) AND convalidated)::integer
    INTO actual_count, expected_count
  FROM pg_constraint
  WHERE conrelid = ANY (ARRAY[
    'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
  ]);
  IF actual_count <> 21 OR expected_count <> 21 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: target constraints are incomplete, invalid, or additional';
  END IF;
  SELECT COUNT(*)::integer INTO actual_count FROM pg_constraint
  WHERE conname = ANY (ARRAY[
    'stock_levels_replenishment_qty_chk','fournisseur_catalogue_conversion_chk',
    'commande_fournisseur_replenishment_fkey'
  ]) AND convalidated;
  IF actual_count <> 3 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: base-table constraints are missing or invalid';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE c.relname = ANY (ARRAY[
           'replenishment_budgets_pkey','replenishment_budgets_scope_uniq',
           'replenishment_proposals_pkey','replenishment_proposals_status_idx',
           'replenishment_proposals_article_site_uniq','replenishment_proposals_article_unmapped_uniq',
           'replenishment_proposal_events_pkey','replenishment_proposal_events_proposal_idx',
           'replenishment_proposal_idempotence_pkey','replenishment_proposal_idem_uniq'
         ]))::integer
    INTO actual_count, expected_count
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = ANY (ARRAY[
    'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
  ]);
  IF actual_count <> 10 OR expected_count <> 10 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: target indexes are incomplete or additional';
  END IF;
  SELECT COUNT(*)::integer INTO actual_count
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.commande_fournisseur'::regclass
    AND c.relname = 'commande_fournisseur_replenishment_idx'
    AND NOT i.indisunique AND i.indpred IS NOT NULL;
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: commande replenishment index is missing or altered';
  END IF;
  SELECT COUNT(*)::integer INTO actual_count
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.replenishment_proposals'::regclass
    AND c.relname IN ('replenishment_proposals_article_site_uniq','replenishment_proposals_article_unmapped_uniq')
    AND i.indisunique AND i.indpred IS NOT NULL;
  IF actual_count <> 2 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: article/site partial uniqueness is missing or altered';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE
           (tgname = 'replenishment_proposal_events_immutable'
             AND tgfoid = 'public.fn_replenishment_event_immutable()'::regprocedure)
           OR (tgname IN ('replenishment_proposals_set_updated_at','replenishment_budgets_set_updated_at')
             AND tgfoid = 'public.tg_set_updated_at()'::regprocedure))::integer
    INTO actual_count, expected_count
  FROM pg_trigger
  WHERE NOT tgisinternal AND tgenabled = 'O'
    AND tgrelid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ]);
  IF actual_count <> 3 OR expected_count <> 3 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: target triggers are incomplete, disabled, altered, or additional';
  END IF;

  SELECT COUNT(*)::integer INTO actual_count
  FROM public.app_modules m, unnest(m.api_prefixes) AS prefix
  WHERE m.module_key = 'commandes-fournisseurs' AND prefix = '/replenishment-proposals';
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: module prefix is missing or duplicated';
  END IF;

  SELECT COUNT(*)::integer INTO actual_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY (ARRAY[
      'replenishment_budgets','replenishment_proposals',
      'replenishment_proposal_events','replenishment_proposal_idempotence'
    ]) AND c.relowner = to_regrole('cerp_app');
  IF actual_count <> 4 OR (
    SELECT proowner FROM pg_proc
    WHERE oid = 'public.fn_replenishment_event_immutable()'::regprocedure
  ) IS DISTINCT FROM to_regrole('cerp_app') THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: runtime ownership is not cerp_app';
  END IF;

  SELECT COUNT(*)::integer INTO actual_count
  FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
  WHERE c.oid = ANY (ARRAY[
    'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
    'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
  ]) AND acl.grantor = to_regrole('cerp_app') AND acl.grantee = to_regrole('cerp_app') AND NOT acl.is_grantable
    AND ((c.relname IN ('replenishment_budgets','replenishment_proposals') AND acl.privilege_type IN ('SELECT','INSERT','UPDATE'))
      OR (c.relname IN ('replenishment_proposal_events','replenishment_proposal_idempotence') AND acl.privilege_type IN ('SELECT','INSERT')));
  IF actual_count <> 10 OR EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid = ANY (ARRAY[
      'public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,
      'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass
    ]) AND (acl.grantee <> to_regrole('cerp_app') OR acl.is_grantable
      OR (c.relname IN ('replenishment_budgets','replenishment_proposals') AND acl.privilege_type NOT IN ('SELECT','INSERT','UPDATE'))
      OR (c.relname IN ('replenishment_proposal_events','replenishment_proposal_idempotence') AND acl.privilege_type NOT IN ('SELECT','INSERT')))
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: table ACL is not exact';
  END IF;

  SELECT COUNT(*)::integer INTO actual_count
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  WHERE p.oid = 'public.fn_replenishment_event_immutable()'::regprocedure
    AND acl.grantor = to_regrole('cerp_app') AND acl.grantee = to_regrole('cerp_app') AND acl.privilege_type = 'EXECUTE'
    AND NOT acl.is_grantable;
  IF actual_count <> 1 OR EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.fn_replenishment_event_immutable()'::regprocedure
      AND (acl.grantee <> to_regrole('cerp_app') OR acl.privilege_type <> 'EXECUTE' OR acl.is_grantable)
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 verify: function ACL is not exact';
  END IF;

  -- Refuse same-named replacements by comparing catalog-derived signatures for
  -- every owned column, constraint, index, trigger, and function definition.
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
  IF actual_count <> 4 THEN RAISE EXCEPTION 'FEAT-CERP-0003 verify: full target column shape is altered'; END IF;

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
  IF actual_count <> 7 THEN RAISE EXCEPTION 'FEAT-CERP-0003 verify: owned constraint definition is altered'; END IF;

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
  IF actual_count <> 5 THEN RAISE EXCEPTION 'FEAT-CERP-0003 verify: owned index definition is altered'; END IF;

  SELECT md5(string_agg(format('%s|%s|%s|%s|%s', tgname, tgtype, tgenabled, tgfoid::regprocedure, encode(tgargs, 'escape')), E'\n' ORDER BY tgname))
    INTO registered_sha256 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY (ARRAY['public.replenishment_budgets'::regclass,'public.replenishment_proposals'::regclass,'public.replenishment_proposal_events'::regclass,'public.replenishment_proposal_idempotence'::regclass]);
  IF registered_sha256 IS DISTINCT FROM '7e574b34d6c795630b9c08be2d6aded2' THEN RAISE EXCEPTION 'FEAT-CERP-0003 verify: owned trigger mapping/event is altered'; END IF;
  SELECT md5(format('%s|%s|%s|%s|%s|%s', pg_get_functiondef(p.oid), p.provolatile, p.proisstrict, p.prosecdef, p.proleakproof, coalesce(array_to_string(p.proconfig, E'\n'), '')))
    INTO registered_sha256 FROM pg_proc p WHERE p.oid = 'public.fn_replenishment_event_immutable()'::regprocedure;
  IF registered_sha256 IS DISTINCT FROM '0e1298dced0e423190dfa3dc059ab371' THEN RAISE EXCEPTION 'FEAT-CERP-0003 verify: immutable function definition/settings are altered'; END IF;
END
$verify$;

SELECT current_database() AS database_name,
       (SELECT sha256 FROM public.cerp_schema_migrations
        WHERE filename = '20260805_replenishment_proposals.sql') AS migration_sha256,
       'FEAT-CERP-0003 verification passed (read-only)' AS result;

ROLLBACK;
