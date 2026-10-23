-- #1423: restricted application roles inherit existing sequence usage.
BEGIN;
SET LOCAL lock_timeout='5s';
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


DO $$
DECLARE v_sequence record; v_grantee record;
BEGIN
 FOR v_sequence IN SELECT oid,relname FROM pg_class WHERE relkind='S' AND relnamespace='public'::regnamespace AND relname LIKE 'cerp_code_issue_%' LOOP
  FOR v_grantee IN SELECT DISTINCT a.grantee FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a WHERE c.oid='public.cerp_business_code_issue_seq'::regclass AND a.privilege_type IN ('USAGE','UPDATE') LOOP
   EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE public.%I TO %s',v_sequence.relname,CASE WHEN v_grantee.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
  END LOOP;
 END LOOP;
END $$;
COMMIT;
