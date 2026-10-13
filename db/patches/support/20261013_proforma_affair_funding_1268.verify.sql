DO $$
DECLARE required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY['proforma_client','delivery_affair_billing_shares','proforma_affair_lines',
    'proforma_billing_parts','delivery_affair_prepayment_terms','proforma_deposit_sources',
    'proforma_receipt_assignments','proforma_receipt_releases'] LOOP
    IF to_regclass('public.'||required_table) IS NULL THEN RAISE EXCEPTION 'proforma #1268 table missing: %',required_table; END IF;
  END LOOP;
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
END;
$$;
SELECT current_database() AS database_name,now() AS verified_at,
  (SELECT count(*) FROM public.proforma_client) AS proformas,
  (SELECT count(*) FROM public.proforma_receipt_assignments) AS receipt_assignments;
