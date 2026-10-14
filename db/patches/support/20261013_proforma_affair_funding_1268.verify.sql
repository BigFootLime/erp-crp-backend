DO $$
DECLARE required_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ged_entity_types WHERE entity_type='PROFORMA' AND module_key='facturation'
    AND target_table='proforma_client' AND target_pk_column='id' AND is_active) THEN
    RAISE EXCEPTION 'proforma #1268 private GED parent missing or misconfigured';
  END IF;
  FOREACH required_table IN ARRAY ARRAY['delivery_prepayment_epoch_1268','proforma_client','delivery_affair_billing_shares','proforma_affair_lines',
    'proforma_billing_parts','delivery_affair_prepayment_terms','proforma_deposit_sources',
    'proforma_receipt_assignments','proforma_receipt_releases','proforma_final_invoice_sources','proforma_final_prepayments'] LOOP
    IF to_regclass('public.'||required_table) IS NULL THEN RAISE EXCEPTION 'proforma #1268 table missing: %',required_table; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.delivery_prepayment_epoch_1268 WHERE singleton)<>1 THEN
    RAISE EXCEPTION 'proforma #1268 snapshot epoch missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname='trg_check_final_prepayments_1268' AND NOT tgisinternal
    AND tgenabled<>'D' AND tgdeferrable AND tginitdeferred)<>10
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.proforma_final_prepayments'::regclass
      AND tgname='trg_final_prepayment_budget_1268' AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'proforma #1268 final advance guards missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.facture WHERE prepaid_amount_ttc<0 OR prepaid_amount_ttc>total_ttc
    OR (amount_due_at_issue IS NOT NULL AND amount_due_at_issue<>total_ttc-prepaid_amount_ttc)) THEN
    RAISE EXCEPTION 'proforma #1268 final net due disagrees with gross and advances';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname='trg_delivery_prepayment_epoch_1268' AND NOT tgisinternal AND tgenabled<>'D')<>6 THEN
    RAISE EXCEPTION 'proforma #1268 fiscal/cash snapshot guards missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D'
    AND tgname IN ('trg_proforma_receipt_budget_1268','trg_proforma_release_budget_1268',
      'trg_protect_proforma_1268','trg_protect_proforma_line_1268','trg_protect_proforma_part_1268',
      'trg_billing_share_balance_1268','trg_proforma_part_balance_1268','trg_proforma_deposit_binding_1268',
      'trg_proforma_terms_binding_1268','trg_proforma_share_identity_1268'))<>10 THEN
    RAISE EXCEPTION 'proforma #1268 mandatory guards missing or disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_affair_prepayment_terms terms
    JOIN public.proforma_affair_lines line ON line.id=terms.proforma_line_id
    WHERE line.allocation_id<>terms.allocation_id) THEN RAISE EXCEPTION 'proforma #1268 affair binding mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM public.proforma_receipt_assignments assignment
    WHERE assignment.amount_ttc<COALESCE((SELECT sum(amount_ttc) FROM public.proforma_receipt_releases
      WHERE assignment_id=assignment.id),0)) THEN RAISE EXCEPTION 'proforma #1268 release exceeds receipt'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger trigger JOIN pg_proc function ON function.oid=trigger.tgfoid
    WHERE trigger.tgrelid='public.facture_source_allocations'::regclass AND trigger.tgname='trg_validate_facture_source_allocation_227'
      AND NOT trigger.tgisinternal AND trigger.tgenabled<>'D' AND function.proname='fn_validate_invoice_source_1268') THEN
    RAISE EXCEPTION 'proforma #1268 invoice source guard is missing or misbound';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.facture_source_allocations'::regclass
    AND tgname='trg_require_deposit_binding_1268' AND NOT tgisinternal AND tgenabled<>'D' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'proforma #1268 deferred fiscal lineage guard is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.facture_source_allocations source WHERE source.source_type='DEPOSIT'
    AND source.allocation_status IN ('DRAFT','CONSUMED') AND NOT EXISTS (
      SELECT 1 FROM public.proforma_deposit_sources binding WHERE binding.facture_source_allocation_id=source.id
    )) THEN RAISE EXCEPTION 'proforma #1268 deposit source has no retained fiscal lineage'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.facture_source_allocations'::regclass
    AND tgname='trg_require_final_binding_1268' AND NOT tgisinternal AND tgenabled<>'D' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.proforma_final_invoice_sources'::regclass
      AND tgname='trg_proforma_final_binding_1268' AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'proforma #1268 final invoice company lineage guards missing';
  END IF;
END;
$$;
SELECT current_database() AS database_name,now() AS verified_at,
  (SELECT count(*) FROM public.proforma_client) AS proformas,
  (SELECT count(*) FROM public.proforma_receipt_assignments) AS receipt_assignments;
