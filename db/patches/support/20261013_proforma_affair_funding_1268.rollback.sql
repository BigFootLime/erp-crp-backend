-- Application rollback/write drain first. Never destroy saved fiscal lineage.
DO $$
DECLARE model_table text; has_evidence boolean;
BEGIN
  IF current_database()<>'cerp_test'
    AND current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1268-empty-model-reviewed' THEN
    RAISE EXCEPTION 'proforma rollback outside cerp_test requires explicit reviewed acknowledgement';
  END IF;
  FOREACH model_table IN ARRAY ARRAY['proforma_client','delivery_affair_billing_shares','proforma_affair_lines',
    'proforma_billing_parts','delivery_affair_prepayment_terms','proforma_deposit_sources',
    'proforma_receipt_assignments','proforma_receipt_releases'] LOOP
    IF to_regclass('public.'||model_table) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I LIMIT 1)',model_table) INTO has_evidence;
      IF has_evidence THEN RAISE EXCEPTION 'proforma rollback refused: % contains saved evidence',model_table; END IF;
    END IF;
  END LOOP;
END;
$$;
DROP TABLE IF EXISTS public.proforma_receipt_releases;
DROP TABLE IF EXISTS public.proforma_receipt_assignments;
DROP TABLE IF EXISTS public.proforma_deposit_sources;
DROP TABLE IF EXISTS public.delivery_affair_prepayment_terms;
DROP TABLE IF EXISTS public.proforma_billing_parts;
DROP TABLE IF EXISTS public.proforma_affair_lines;
DROP TABLE IF EXISTS public.delivery_affair_billing_shares;
DROP TABLE IF EXISTS public.proforma_client;
DROP SEQUENCE IF EXISTS public.proforma_client_reference_seq;
DROP FUNCTION IF EXISTS public.fn_proforma_receipt_budget_1268();
DROP FUNCTION IF EXISTS public.fn_protect_proforma_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_quantity_balance_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_source_binding_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_terms_binding_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_share_identity_1268();
