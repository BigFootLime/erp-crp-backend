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
    'proforma_receipt_assignments','proforma_receipt_releases','proforma_final_invoice_sources','proforma_final_prepayments'] LOOP
    IF to_regclass('public.'||model_table) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I LIMIT 1)',model_table) INTO has_evidence;
      IF has_evidence THEN RAISE EXCEPTION 'proforma rollback refused: % contains saved evidence',model_table; END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='facture' AND column_name='amount_due_at_issue') THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.facture WHERE amount_due_at_issue IS NOT NULL OR prepaid_amount_ttc<>0)' INTO has_evidence;
    IF has_evidence THEN RAISE EXCEPTION 'proforma rollback refused: final invoice net due contains saved evidence'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.finance_command_receipts WHERE aggregate_type='PROFORMA')
    OR EXISTS(SELECT 1 FROM public.finance_event_log WHERE aggregate_type='PROFORMA') THEN
    RAISE EXCEPTION 'proforma rollback refused: Finance contains saved proforma commands/events';
  END IF;
  IF EXISTS(SELECT 1 FROM public.ged_document_links WHERE entity_type='PROFORMA')
    OR EXISTS(SELECT 1 FROM public.authoritative_pdf_archives WHERE entity_type='proforma') THEN
    RAISE EXCEPTION 'proforma rollback refused: contains saved evidence in document archives';
  END IF;
END;
$$;
DO $$ DECLARE guarded_table text; BEGIN
 FOREACH guarded_table IN ARRAY ARRAY['facture','facture_source_allocations','facture_echeance','proforma_final_prepayments',
  'paiement','paiement_allocations','avoir','avoir_source_allocations','proforma_receipt_assignments','proforma_receipt_releases'] LOOP
  IF to_regclass('public.'||guarded_table) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS trg_check_final_prepayments_1268 ON public.%I',guarded_table);
  END IF;
 END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.fn_check_final_prepayments_1268();
DROP FUNCTION IF EXISTS public.fn_invoice_applied_prepayment_1268(bigint);
DROP FUNCTION IF EXISTS public.fn_final_prepayment_targets_1268(bigint);
DROP TABLE IF EXISTS public.proforma_final_prepayments;
DROP FUNCTION IF EXISTS public.fn_final_prepayment_budget_1268();
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_prepaid_amount_1268_ck;
ALTER TABLE public.facture DROP COLUMN IF EXISTS prepaid_amount_ttc;
ALTER TABLE public.facture DROP COLUMN IF EXISTS amount_due_at_issue;
ALTER TABLE public.facture_echeance DROP COLUMN IF EXISTS amount_autofilled;
ALTER TABLE public.facture_echeance DROP CONSTRAINT IF EXISTS facture_echeance_nonnegative_due_1268_ck;
ALTER TABLE public.facture_echeance ADD CONSTRAINT facture_echeance_amount_due_check CHECK(amount_due>0);
ALTER TABLE public.finance_command_receipts DROP CONSTRAINT IF EXISTS finance_command_receipts_aggregate_type_check;
ALTER TABLE public.finance_command_receipts ADD CONSTRAINT finance_command_receipts_aggregate_type_check CHECK (aggregate_type IN ('FACTURE','AVOIR','PAIEMENT'));
ALTER TABLE public.finance_event_log DROP CONSTRAINT IF EXISTS finance_event_log_aggregate_type_check;
ALTER TABLE public.finance_event_log ADD CONSTRAINT finance_event_log_aggregate_type_check CHECK (aggregate_type IN ('FACTURE','AVOIR','PAIEMENT'));
-- The additive order currency column is retained; old code ignores it and no
-- commercial currency evidence is destroyed during an application rollback.
DROP TRIGGER IF EXISTS trg_require_deposit_binding_1268 ON public.facture_source_allocations;
DROP TRIGGER IF EXISTS trg_require_final_binding_1268 ON public.facture_source_allocations;
DROP FUNCTION IF EXISTS public.fn_require_final_binding_1268();
DROP TABLE IF EXISTS public.proforma_final_invoice_sources;
DROP FUNCTION IF EXISTS public.fn_proforma_final_binding_1268();
DROP TRIGGER IF EXISTS trg_validate_facture_source_allocation_227 ON public.facture_source_allocations;
CREATE TRIGGER trg_validate_facture_source_allocation_227 BEFORE INSERT ON public.facture_source_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();
DROP FUNCTION IF EXISTS public.fn_require_deposit_binding_1268();
DROP FUNCTION IF EXISTS public.fn_validate_invoice_source_1268();
DROP TABLE IF EXISTS public.proforma_receipt_releases;
DROP TABLE IF EXISTS public.proforma_receipt_assignments;
DROP TABLE IF EXISTS public.proforma_deposit_sources;
DROP TABLE IF EXISTS public.delivery_affair_prepayment_terms;
DROP TABLE IF EXISTS public.proforma_billing_parts;
DROP TABLE IF EXISTS public.proforma_affair_lines;
DROP TABLE IF EXISTS public.delivery_affair_billing_shares;
DROP TABLE IF EXISTS public.proforma_client;
DELETE FROM public.ged_entity_types WHERE entity_type='PROFORMA' AND target_table='proforma_client';
DROP SEQUENCE IF EXISTS public.proforma_client_reference_seq;
DROP FUNCTION IF EXISTS public.fn_proforma_receipt_budget_1268();
DROP FUNCTION IF EXISTS public.fn_protect_proforma_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_quantity_balance_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_source_binding_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_terms_binding_1268();
DROP FUNCTION IF EXISTS public.fn_proforma_share_identity_1268();
DO $$ DECLARE guarded_table text; BEGIN
  FOREACH guarded_table IN ARRAY ARRAY['paiement','paiement_allocations','facture','facture_source_allocations','avoir','avoir_source_allocations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_delivery_prepayment_epoch_1268 ON public.%I',guarded_table);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.fn_touch_delivery_prepayment_1268();
DROP FUNCTION IF EXISTS public.fn_lock_delivery_prepayment_read_1268();
DROP FUNCTION IF EXISTS public.fn_lock_delivery_prepayment_write_1268();
DROP TABLE IF EXISTS public.delivery_prepayment_epoch_1268;
