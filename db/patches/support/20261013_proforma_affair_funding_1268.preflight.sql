DO $$
DECLARE required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY['clients','users','commande_client','commande_ligne','affaire',
    'commande_ligne_affaire_allocation','facture','facture_ligne','facture_source_allocations',
    'paiement','paiement_allocations','avoir','avoir_source_allocations',
    'bon_livraison','bon_livraison_ligne','bon_livraison_ligne_allocations'] LOOP
    IF to_regclass('public.'||required_table) IS NULL THEN
      RAISE EXCEPTION 'proforma #1268 prerequisite missing: %',required_table;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='facture' AND column_name='document_status') THEN
    RAISE EXCEPTION 'proforma #1268 requires canonical Finance document/settlement migration #469';
  END IF;
END;
$$;
SELECT current_database() AS database_name,now() AS preflight_at,
  'No historical prepayment decision inferred or changed' AS historical_policy;
