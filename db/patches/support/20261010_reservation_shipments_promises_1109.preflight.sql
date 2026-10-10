DO $$ BEGIN
  IF to_regprocedure('public.guard_delivery_promise_history()') IS NULL
    OR to_regclass('public.bon_livraison_ship_receipts') IS NULL
    OR to_regclass('public.delivery_promise_shipments') IS NULL THEN
    RAISE EXCEPTION 'Delivery promise and reservation-cart dependencies required';
  END IF;
  IF to_regclass('public.delivery_promise_shipment_reconciliations') IS NOT NULL THEN
    RAISE EXCEPTION 'Reconciliation already installed; inspect patch ledger';
  END IF;
END $$;
SELECT count(*) AS tracked_missing_or_partial_shipment_captures
FROM public.bon_livraison_ligne_allocations a JOIN public.bon_livraison_ligne line ON line.id=a.bon_livraison_ligne_id
JOIN public.bon_livraison bl ON bl.id=line.bon_livraison_id
JOIN public.delivery_promise_roots r ON r.allocation_id=a.commande_ligne_affaire_allocation_id
WHERE bl.statut IN('SHIPPED','DELIVERED') AND a.quantite>0
  AND COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s WHERE s.bl_allocation_id=a.id),0)<>a.quantite;
