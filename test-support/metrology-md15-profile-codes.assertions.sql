-- Assertions for the isolated MD15 fixture after the patch has been applied.
DO $$
DECLARE
  v_pc bigint;
  v_tfd bigint;
  v_immutable boolean := false;
BEGIN
  v_pc := public.fn_next_issued_code_value('MTR:PC');
  v_tfd := public.fn_next_issued_code_value('MTR:TFD');
  IF v_pc <> 61 THEN RAISE EXCEPTION 'Expected PC allocation 61, got %', v_pc; END IF;
  IF v_tfd <> 4 THEN RAISE EXCEPTION 'Expected TFD allocation 4, got %', v_tfd; END IF;
  BEGIN
    UPDATE public.metrologie_equipements SET code = 'PC-61' WHERE code = 'PC-60';
  EXCEPTION WHEN OTHERS THEN
    v_immutable := SQLSTATE = 'P0001';
  END;
  IF NOT v_immutable THEN RAISE EXCEPTION 'Equipment code guard did not reject a rename'; END IF;
END $$;

-- The generated scopes are independent and their reservations are preserved.
SELECT public.fn_business_code_scope_sequence('MTR:PC')::text AS pc_scope,
       public.fn_business_code_scope_sequence('MTR:TFD')::text AS tfd_scope;
