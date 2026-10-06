DO $$ BEGIN
  IF to_regclass('public.commande_ligne_affaire_allocation') IS NULL
    OR to_regclass('public.bon_livraison_ligne_allocations') IS NULL
    OR to_regclass('public.commande_ar_log') IS NULL
    OR to_regclass('public.planning_central_settings') IS NULL THEN
    RAISE EXCEPTION 'Missing L3 commercial/planning prerequisites';
  END IF;
END $$;
SELECT count(*) AS sent_acknowledgements FROM public.commande_ar_log WHERE status='SENT';
