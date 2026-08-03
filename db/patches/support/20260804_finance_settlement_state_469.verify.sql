-- Read-only verification for issue #469.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#469 verification is restricted to cerp_test';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.facture
    WHERE document_status IS NULL OR settlement_status IS NULL
  ) THEN
    RAISE EXCEPTION 'Invoice document/settlement backfill is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.facture
    WHERE statut IN ('ISSUED','PARTIALLY_PAID','PAID') AND document_status <> 'ISSUED'
  ) THEN
    RAISE EXCEPTION 'Canonical issued invoice lifecycle backfill is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.facture f
    WHERE COALESCE((
      SELECT SUM(pa.amount_ttc) FROM public.paiement_allocations pa WHERE pa.facture_id = f.id
    ), 0) + COALESCE((
      SELECT SUM(asa.amount_ttc)
      FROM public.avoir_source_allocations asa
      WHERE asa.facture_id = f.id AND asa.allocation_status = 'CONSUMED'
    ), 0) > f.total_ttc
  ) THEN
    RAISE EXCEPTION 'Invoice allocation cap verification failed';
  END IF;
END $$;

SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid IN ('public.facture'::regclass, 'public.avoir'::regclass)
  AND conname IN (
    'facture_statut_469_ck',
    'facture_document_status_469_ck',
    'facture_settlement_status_469_ck',
    'avoir_statut_469_ck'
  )
ORDER BY conname;

SELECT document_status, settlement_status, statut, COUNT(*) AS invoice_count
FROM public.facture
GROUP BY document_status, settlement_status, statut
ORDER BY document_status, settlement_status, statut;
