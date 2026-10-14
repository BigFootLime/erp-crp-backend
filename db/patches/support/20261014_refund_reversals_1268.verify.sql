DO $$ BEGIN
 IF to_regclass('public.customer_refunds_effective_1268') IS NULL
   OR to_regclass('public.customer_refund_sources_effective_1268') IS NULL
   OR NOT has_table_privilege('cerp_app','public.customer_refund_reversals','SELECT,INSERT')
   OR has_table_privilege('cerp_app','public.customer_refund_reversals','UPDATE,DELETE') THEN
  RAISE EXCEPTION 'REFUND-REVERSAL-1268 effective readers and immutable evidence grants required';
 END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='trg_retain_refund_accounting_1268' AND NOT tgisinternal AND tgenabled='O')<>2
   OR (SELECT count(*) FROM pg_trigger WHERE tgname='trg_lock_refund_accounting_1268' AND NOT tgisinternal AND tgenabled='O')<>2
   OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.customer_refund_reversals'::regclass
     AND tgname='trg_check_customer_refunds_1268' AND tgdeferrable AND tginitdeferred AND tgenabled='O')<>1 THEN
  RAISE EXCEPTION 'REFUND-REVERSAL-1268 original posting and deferred settlement guards required';
 END IF;
 IF position('customer_refunds_effective_1268' IN pg_get_functiondef('public.fn_check_customer_refunds_1268()'::regprocedure))=0 THEN
  RAISE EXCEPTION 'REFUND-REVERSAL-1268 settlement must read compensated refund budgets';
 END IF;
END $$;
