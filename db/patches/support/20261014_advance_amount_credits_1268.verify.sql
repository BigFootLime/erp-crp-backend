DO $$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='trg_check_advance_amount_credit_1268' AND NOT tgisinternal
   AND tgdeferrable AND tginitdeferred AND tgenabled='O')<>2
   OR to_regprocedure('public.fn_check_advance_amount_credit_1268()') IS NULL THEN
   RAISE EXCEPTION 'ADVANCE-AMOUNT-1268 missing deferred canonical budget guards';
 END IF;
END $$;
