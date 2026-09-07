-- #749: restore FIN after an older allocator definition was reapplied.
-- No business row or sequence value is changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.fn_next_issued_code_value(text)'::regprocedure) INTO definition;
  IF position('CLI|FOU|MCH|MET|ART:' in definition) = 0
     AND position('CLI|FOU|MCH|MET|FIN|ART:' in definition) = 0 THEN
    RAISE EXCEPTION '#749: unexpected allocator definition; review before changing its accepted scopes';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|MCH|MET|FIN|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER|MEX|MIA):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;
COMMIT;
