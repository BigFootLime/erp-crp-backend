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
    WHERE statut IN (
      'ISSUED','PARTIALLY_PAID','PAID','emis','emise','envoyee','partielle','payee'
    ) AND document_status <> 'ISSUED'
  ) THEN
    RAISE EXCEPTION 'Canonical issued invoice lifecycle backfill is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.facture f
    WHERE COALESCE((
      SELECT SUM(pa.amount_ttc) FROM public.paiement_allocations pa WHERE pa.facture_id = f.id
    ), 0) + COALESCE((
      SELECT SUM(p.montant)
      FROM public.paiement p
      WHERE p.facture_id = f.id
        AND NOT EXISTS (
          SELECT 1 FROM public.paiement_allocations existing_pa
          WHERE existing_pa.paiement_id = p.id
        )
    ), 0) + COALESCE((
      SELECT SUM(asa.amount_ttc)
      FROM public.avoir_source_allocations asa
      WHERE asa.facture_id = f.id AND asa.allocation_status = 'CONSUMED'
    ), 0) + COALESCE((
      SELECT SUM(a.total_ttc)
      FROM public.avoir a
      WHERE a.facture_id = f.id
        AND a.statut IN ('ISSUED','emis','emise','envoyee')
        AND NOT EXISTS (
          SELECT 1 FROM public.avoir_source_allocations existing_asa
          WHERE existing_asa.avoir_id = a.id
        )
    ), 0) > f.total_ttc
  ) THEN
    RAISE EXCEPTION 'Invoice allocation cap verification failed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.facture f
    CROSS JOIN LATERAL (
      SELECT (
        COALESCE((
          SELECT SUM(pa.amount_ttc) FROM public.paiement_allocations pa WHERE pa.facture_id = f.id
        ), 0) + COALESCE((
          SELECT SUM(p.montant)
          FROM public.paiement p
          WHERE p.facture_id = f.id
            AND NOT EXISTS (
              SELECT 1 FROM public.paiement_allocations existing_pa
              WHERE existing_pa.paiement_id = p.id
            )
        ), 0) + COALESCE((
          SELECT SUM(asa.amount_ttc)
          FROM public.avoir_source_allocations asa
          WHERE asa.facture_id = f.id AND asa.allocation_status = 'CONSUMED'
        ), 0) + COALESCE((
          SELECT SUM(a.total_ttc)
          FROM public.avoir a
          WHERE a.facture_id = f.id
            AND a.statut IN ('ISSUED','emis','emise','envoyee')
            AND NOT EXISTS (
              SELECT 1 FROM public.avoir_source_allocations existing_asa
              WHERE existing_asa.avoir_id = a.id
            )
        ), 0)
      )::numeric(18,2) AS settled_ttc
    ) balance
    WHERE f.settlement_status <> CASE
      WHEN balance.settled_ttc >= f.total_ttc AND f.total_ttc > 0 THEN 'PAID'
      WHEN balance.settled_ttc > 0 THEN 'PARTIALLY_PAID'
      WHEN f.statut = 'PAID' OR lower(f.statut) = 'payee' THEN 'PAID'
      WHEN f.statut = 'PARTIALLY_PAID' OR lower(f.statut) = 'partielle' THEN 'PARTIALLY_PAID'
      ELSE 'UNPAID'
    END
  ) THEN
    RAISE EXCEPTION 'Invoice settlement derivation verification failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'facture_statut_469_ck'
      AND c.conrelid = 'public.facture'::regclass
      AND c.convalidated = FALSE
      AND pg_get_constraintdef(c.oid) LIKE '%brouillon%'
      AND pg_get_constraintdef(c.oid) LIKE '%partielle%'
      AND pg_get_constraintdef(c.oid) LIKE '%annulee%'
  ) THEN
    RAISE EXCEPTION 'facture_statut_469_ck is missing, validated unexpectedly, or incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'facture_document_status_469_ck'
      AND c.conrelid = 'public.facture'::regclass
      AND c.convalidated = TRUE
      AND pg_get_constraintdef(c.oid) LIKE '%LEGACY%'
      AND pg_get_constraintdef(c.oid) LIKE '%ISSUED%'
  ) THEN
    RAISE EXCEPTION 'facture_document_status_469_ck is missing, unvalidated, or incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'facture_settlement_status_469_ck'
      AND c.conrelid = 'public.facture'::regclass
      AND c.convalidated = TRUE
      AND pg_get_constraintdef(c.oid) LIKE '%UNPAID%'
      AND pg_get_constraintdef(c.oid) LIKE '%PARTIALLY_PAID%'
      AND pg_get_constraintdef(c.oid) LIKE '%PAID%'
  ) THEN
    RAISE EXCEPTION 'facture_settlement_status_469_ck is missing, unvalidated, or incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'avoir_statut_469_ck'
      AND c.conrelid = 'public.avoir'::regclass
      AND c.convalidated = FALSE
      AND pg_get_constraintdef(c.oid) LIKE '%brouillon%'
      AND pg_get_constraintdef(c.oid) LIKE '%envoyee%'
      AND pg_get_constraintdef(c.oid) LIKE '%annulee%'
  ) THEN
    RAISE EXCEPTION 'avoir_statut_469_ck is missing, validated unexpectedly, or incomplete';
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
