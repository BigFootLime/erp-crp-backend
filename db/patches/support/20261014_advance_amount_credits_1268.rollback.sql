BEGIN;
DO $$ BEGIN
 IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-amount-credits-reviewed' THEN
   RAISE EXCEPTION 'Advance amount credit rollback requires explicit reviewed acknowledgement';
 END IF;
 IF EXISTS(SELECT 1 FROM public.avoir_source_allocations WHERE source_type='INVOICE_AMOUNT') THEN
   RAISE EXCEPTION 'Advance amount credit rollback refused: saved monetary credit evidence exists';
 END IF;
END $$;
DROP TRIGGER trg_check_advance_amount_credit_1268 ON public.avoir_source_allocations;
DROP TRIGGER trg_check_advance_amount_credit_1268 ON public.avoir_ligne;
DROP FUNCTION public.fn_check_advance_amount_credit_1268();
COMMIT;
