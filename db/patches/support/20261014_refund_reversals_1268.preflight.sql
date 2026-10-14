DO $$ BEGIN
 IF to_regclass('public.customer_refunds') IS NULL OR to_regclass('public.customer_refund_sources') IS NULL
   OR to_regprocedure('public.fn_check_advance_amount_credit_1268()') IS NULL
   OR to_regprocedure('public.fn_lock_delivery_prepayment_write_1268()') IS NULL THEN
  RAISE EXCEPTION 'REFUND-REVERSAL-1268 qualified monetary credits and refund prerequisites required';
 END IF;
 IF EXISTS(SELECT 1 FROM public.customer_refunds r
   WHERE r.amount_ttc<>(SELECT COALESCE(sum(amount_ttc),0) FROM public.customer_refund_sources WHERE refund_id=r.id)) THEN
  RAISE EXCEPTION 'REFUND-REVERSAL-1268 reconcile original refund sources first';
 END IF;
END $$;
