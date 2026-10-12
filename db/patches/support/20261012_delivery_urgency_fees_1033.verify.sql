BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.client_urgency_fee_settings') IS NULL
    OR to_regclass('public.delivery_urgency_order_charges') IS NULL
    OR to_regclass('public.facture_urgency_charges') IS NULL THEN
    RAISE EXCEPTION 'Urgency fee relations missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_order_charges GROUP BY commande_id HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM public.facture_urgency_charges GROUP BY charge_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate urgency fee evidence';
  END IF;
  IF has_table_privilege('cerp_app','public.delivery_urgency_order_charges','UPDATE,DELETE')
    OR has_table_privilege('cerp_app','public.facture_urgency_charges','UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Urgency evidence permissions too broad';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgname IN('urgency_charge_identity','urgency_withdrawal_charge','urgency_charge_withdrawal',
      'facture_urgency_charge','protect_facture_urgency_line'))<>5 THEN
    RAISE EXCEPTION 'Urgency charge guard missing';
  END IF;
END $$;
ROLLBACK;
