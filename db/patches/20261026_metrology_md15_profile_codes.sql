-- Métrologie MD15 : compteurs séparés par famille de code (PC-01, ME-01…).
--
-- Les valeurs ci-dessous sont uniquement des bornes de réservation établies
-- lors de l'analyse des dossiers historiques. Aucun équipement, propriétaire,
-- certificat ou relevé historique n'est importé par ce patch.

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
  IF v_scope !~ '^(CLI|FOU|MCH|MET|FIN|ART:[A-Z0-9]{1,48}|MTR:[A-Z0-9]{2,8}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER|MEX|MIA):[0-9]{4})$' THEN
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
      FOR v_grantee IN
        SELECT DISTINCT a.grantee FROM pg_class c,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a
        WHERE c.oid='public.cerp_business_code_issue_seq'::regclass AND a.privilege_type IN ('USAGE','UPDATE')
      LOOP
        EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE public.%I TO %s',v_name,
          CASE WHEN v_grantee.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
      END LOOP;
      v_sequence := to_regclass(format('public.%I', v_name));
    END IF;
  END IF;
  RETURN v_sequence;
END $$;

CREATE TEMP TABLE metrology_md15_code_floor_20261026(prefix text PRIMARY KEY, floor_value bigint NOT NULL) ON COMMIT DROP;
INSERT INTO metrology_md15_code_floor_20261026(prefix, floor_value) VALUES
  ('BF',65),('BL',21),('CA',4),('JP',7),('ME',26),('MES',2),('MI',18),('OUT',7),('PC',58),('TF',110),('TFD',3),('TLD',50);

DO $$
DECLARE r record; v_sequence regclass; v_existing bigint; v_last bigint; v_called boolean;
BEGIN
  FOR r IN SELECT * FROM metrology_md15_code_floor_20261026 ORDER BY prefix LOOP
    SELECT GREATEST(r.floor_value, COALESCE(MAX((regexp_match(code, ('^' || r.prefix || '-([0-9]+)$')))[1]::bigint), 0))
      INTO v_existing
      FROM public.metrologie_equipements
     WHERE code ~ ('^' || r.prefix || '-[0-9]+$');
    v_sequence := public.fn_business_code_scope_sequence('MTR:' || r.prefix);
    EXECUTE format('SELECT last_value,is_called FROM %s',v_sequence) INTO v_last,v_called;
    IF v_existing > v_last OR (v_existing = v_last AND NOT v_called) THEN
      PERFORM setval(v_sequence,v_existing,true);
    END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.fn_business_code_scope_sequence(text) IS
  'Independent native PostgreSQL sequence per validated business-code scope, including MD15 metrology families MTR:<prefix>.';

COMMIT;
