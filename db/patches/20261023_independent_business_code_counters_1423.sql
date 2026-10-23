-- #1423: one native sequence per exact business-code scope. Existing references
-- and independent stock/delivery/accounting allocators remain unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_business_code_scope_sequence(p_scope text)
RETURNS regclass LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
  v_name text;
  v_sequence regclass;
  v_grantee record;
BEGIN
  IF v_scope !~ '^(CLI|FOU|MCH|MET|FIN|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER|MEX|MIA):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope USING ERRCODE = '22023';
  END IF;
  v_name := 'cerp_code_issue_' || md5(v_scope) || '_seq';
  v_sequence := to_regclass(format('public.%I', v_name));
  IF v_sequence IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cerp-business-code:' || v_scope, 0));
    v_sequence := to_regclass(format('public.%I', v_name));
    IF v_sequence IS NULL THEN
      EXECUTE format('CREATE SEQUENCE public.%I AS bigint MINVALUE 1 START 1 INCREMENT 1 NO CYCLE CACHE 1%s',
        v_name, CASE WHEN v_scope = 'CLI' THEN ' MAXVALUE 999' ELSE '' END);
      EXECUTE format('COMMENT ON SEQUENCE public.%I IS %L', v_name, 'Business-code scope: ' || v_scope);
      -- Preserve the old sequence's consumers, including the restricted demo
      -- application role. Applications never need CREATE on the public schema.
      FOR v_grantee IN
        SELECT DISTINCT a.grantee FROM pg_class c,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a
        WHERE c.oid='public.cerp_business_code_issue_seq'::regclass
          AND a.privilege_type IN ('USAGE','UPDATE')
      LOOP
        EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE public.%I TO %s',v_name,
          CASE WHEN v_grantee.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
      END LOOP;
      v_sequence := to_regclass(format('public.%I', v_name));
    END IF;
  END IF;
  RETURN v_sequence;
END $$;

-- Collect persisted codes, including archived records, before switching the
-- allocator. This is a one-time seed, never MAX+1 on the request path.
CREATE TEMP TABLE cerp_code_scope_seed_1423(scope text PRIMARY KEY, value bigint NOT NULL) ON COMMIT DROP;
INSERT INTO cerp_code_scope_seed_1423 VALUES ('CLI',0),('FOU',0),('MCH',0),('MET',0),('FIN',0);
DO $$
DECLARE r record; v_pattern text; v_scope_expr text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('clients','client_code','CLI'),('fournisseurs','code','FOU'),
    ('machines','code','MCH'),('metrologie_equipements','code','MET'),
    ('surface_finishes','code','FIN'),('articles','code','ART'),
    ('devis','numero','DEV'),('commande_client','numero','CMD'),
    ('affaire','reference','AFF'),('ordres_fabrication','numero','OF'),
    ('lots','lot_code','LOT'),('stock_movements','movement_no','MVT'),
    ('quality_control','reference','CQ'),('non_conformity','reference','NC'),
    ('quality_action','reference','CAPA'),('bon_livraison','numero','BL'),
    ('facture','numero','FACT'),('commande_fournisseur','code','BCF'),
    ('quality_control_plan','code','PC'),('quality_derogation','code','DER'),
    ('metrologie_execution','code','MEX'),('metrologie_impact_dossier','code','MIA')
  ) AS sources(table_name,column_name,prefix) LOOP
    IF to_regclass(format('public.%I',r.table_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',r.table_name);
    IF r.prefix IN ('CLI','FOU','MCH','MET','FIN') THEN
      v_pattern := '^' || r.prefix || '-([0-9]+)$';
      v_scope_expr := quote_literal(r.prefix);
    ELSIF r.prefix = 'ART' THEN
      v_pattern := '^ART-([A-Z0-9]{1,48})-([0-9]+)$';
      v_scope_expr := '''ART:'' || m[1]';
    ELSE
      v_pattern := '^' || r.prefix || '-([0-9]{4})-([0-9]+)$';
      v_scope_expr := quote_literal(r.prefix || ':') || ' || m[1]';
    END IF;
    EXECUTE format(
      'INSERT INTO cerp_code_scope_seed_1423 SELECT %s, max(m[cardinality(m)]::bigint) FROM (SELECT regexp_match(%I,%L) m FROM public.%I) codes WHERE m IS NOT NULL %s GROUP BY 1 ON CONFLICT(scope) DO UPDATE SET value=GREATEST(cerp_code_scope_seed_1423.value,EXCLUDED.value)',
      v_scope_expr,r.column_name,v_pattern,r.table_name,
      -- CLI-999 is also used as the retained internal-company code. Reserve
      -- that occupied slot without exhausting every lower, unused client code.
      CASE WHEN r.prefix='CLI' THEN 'AND m[1]::bigint < 999' ELSE '' END);
  END LOOP;
  -- Prepare existing article families and this/next year's scopes up front,
  -- so ordinary failed creations keep non-transactional sequence semantics.
  INSERT INTO cerp_code_scope_seed_1423
  SELECT 'ART:' || family_code,0 FROM public.articles
  WHERE family_code ~ '^[A-Z0-9]{1,48}$' GROUP BY family_code
  ON CONFLICT DO NOTHING;
  FOR r IN SELECT * FROM (VALUES ('articles_achat_families'),('articles_fabrique_families'),('articles_matiere_families'),('articles_traitement_families')) t(name) LOOP
    IF to_regclass(format('public.%I',r.name)) IS NOT NULL THEN
      EXECUTE format('INSERT INTO cerp_code_scope_seed_1423 SELECT ''ART:'' || code,0 FROM public.%I WHERE code ~ ''^[A-Z0-9]{1,48}$'' ON CONFLICT DO NOTHING',r.name);
    END IF;
  END LOOP;
  INSERT INTO cerp_code_scope_seed_1423
  SELECT prefix || ':' || year,0
  FROM unnest(ARRAY['DEV','CMD','AFF','OF','LOT','MVT','CQ','NC','CAPA','BL','FACT','BCF','PC','DER','MEX','MIA']) prefix
  CROSS JOIN generate_series(extract(year FROM current_date)::int,extract(year FROM current_date)::int+1) year
  ON CONFLICT DO NOTHING;
END $$;

DO $$
DECLARE r record; v_sequence regclass; v_last bigint; v_called boolean;
BEGIN
  FOR r IN SELECT * FROM cerp_code_scope_seed_1423 ORDER BY scope LOOP
    v_sequence := public.fn_business_code_scope_sequence(r.scope);
    EXECUTE format('SELECT last_value,is_called FROM %s',v_sequence) INTO v_last,v_called;
    IF r.value > 0 AND (r.value > v_last OR (r.value=v_last AND NOT v_called)) THEN
      PERFORM setval(v_sequence,r.value,true);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope,'')));
  v_sequence regclass;
  v_value bigint;
BEGIN
  v_sequence := public.fn_business_code_scope_sequence(v_scope);
  LOOP
    v_value := nextval(v_sequence);
    -- Explicitly imported/reserved client slots (including the internal CLI-999)
    -- cannot be reissued. Exhaustion raises before returning a fourth digit.
    IF v_scope <> 'CLI' OR NOT EXISTS (
      SELECT 1 FROM public.clients WHERE client_code='CLI-' || lpad(v_value::text,3,'0')
    ) THEN RETURN v_value; END IF;
  END LOOP;
END $$;
COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Independent native PostgreSQL sequence per validated scope; article family and document year are separate. CLI is bounded 001..999. Legacy shared sequence is retained but no longer allocated.';
COMMIT;
