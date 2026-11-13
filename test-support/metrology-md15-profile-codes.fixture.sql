-- Fixture PostgreSQL jetable MD15. Elle ne contient aucune donnée métier.
-- À charger dans une base vide avant 20261026_metrology_md15_profile_codes.sql.
CREATE TABLE public.metrologie_equipements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text,
  specifications jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX metrologie_equipements_code_uniq
  ON public.metrologie_equipements(code) WHERE code IS NOT NULL;

CREATE SEQUENCE public.cerp_business_code_issue_seq AS bigint MINVALUE 1 START 1;

CREATE OR REPLACE FUNCTION public.fn_business_code_scope_sequence(p_scope text)
RETURNS regclass LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
  v_name text;
  v_sequence regclass;
BEGIN
  IF v_scope !~ '^(CLI|FOU|MCH|MET|FIN|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER|MEX|MIA):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope USING ERRCODE = '22023';
  END IF;
  v_name := 'cerp_code_issue_' || md5(v_scope) || '_seq';
  v_sequence := to_regclass(format('public.%I', v_name));
  IF v_sequence IS NULL THEN
    EXECUTE format('CREATE SEQUENCE public.%I AS bigint MINVALUE 1 START 1 INCREMENT 1 NO CYCLE CACHE 1', v_name);
    EXECUTE format('COMMENT ON SEQUENCE public.%I IS %L', v_name, 'Business-code scope: ' || v_scope);
    v_sequence := to_regclass(format('public.%I', v_name));
  END IF;
  RETURN v_sequence;
END $$;

CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RETURN nextval(public.fn_business_code_scope_sequence(upper(btrim(p_scope))));
END $$;

CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_equipement_229()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'Equipment code is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_protect_metrologie_equipement_229
  BEFORE UPDATE ON public.metrologie_equipements
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_equipement_229();

INSERT INTO public.metrologie_equipements(code) VALUES ('PC-58'),('PC-60'),('TFD-03');
