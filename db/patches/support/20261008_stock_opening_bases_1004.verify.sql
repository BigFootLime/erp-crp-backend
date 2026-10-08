DO $$ BEGIN
  IF to_regclass('public.stock_valuation_opening_bases') IS NULL
    OR to_regprocedure('public.fn_stock_opening_candidate_1004(uuid,text)') IS NULL
    OR to_regprocedure('public.fn_stock_opening_entry_basis_1004(uuid,text,text,text,numeric,numeric,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Opening declaration structures are missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.stock_valuation_opening_bases'::regclass
    AND NOT tgisinternal AND tgenabled='O')<>2 THEN
    RAISE EXCEPTION 'Opening basis guards are missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_opening_bases
    WHERE source_sha256<>encode(digest(source_snapshot::text,'sha256'),'hex') OR source_reliability<>'DECLARED') THEN
    RAISE EXCEPTION 'Opening basis checksum is invalid';
  END IF;
END $$;
