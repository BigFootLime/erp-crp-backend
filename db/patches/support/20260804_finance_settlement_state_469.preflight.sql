-- Read-only preflight for issue #469. Run only against the explicitly selected database.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#469 preflight is restricted to cerp_test';
  END IF;
  IF to_regclass('public.facture') IS NULL
     OR to_regclass('public.paiement_allocations') IS NULL
     OR to_regclass('public.avoir_source_allocations') IS NULL THEN
    RAISE EXCEPTION 'Issue #227 Finance schema is required before #469';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_protect_facture_immutable_227' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Issue #227 immutable invoice trigger is missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.facture f
    WHERE COALESCE((
      SELECT SUM(pa.amount_ttc)
      FROM public.paiement_allocations pa
      JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id
      WHERE pa.facture_id = f.id
        AND allocated_payment.status NOT IN ('REJECTED','REVERSED')
        AND allocated_payment.workflow_status <> 'REVERSED'
        AND allocated_payment.reversal_of_id IS NULL
    ), 0) + COALESCE((
      SELECT SUM(p.montant)
      FROM public.paiement p
      WHERE p.facture_id = f.id
        AND p.status NOT IN ('REJECTED','REVERSED')
        AND p.workflow_status <> 'REVERSED'
        AND p.reversal_of_id IS NULL
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
    RAISE EXCEPTION '#469 preflight refused: an invoice is already over-allocated';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.paiement p
    WHERE p.facture_id IS NOT NULL
      AND NOT (
        p.uuid IS NOT NULL
        AND p.code IS NOT NULL
        AND p.correlation_id IS NOT NULL
        AND p.idempotency_key IS NOT NULL
        AND p.request_hash IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.paiement_allocations pa WHERE pa.paiement_id = p.id
      )
  ) THEN
    RAISE EXCEPTION '#469 preflight refused: direct legacy payment evidence was already converted to allocations';
  END IF;
END $$;

SELECT
  COUNT(*) FILTER (WHERE statut IS NULL OR btrim(statut) = '') AS blank_statuses,
  COUNT(*) FILTER (WHERE statut NOT IN (
    'DRAFT','PENDING_VALIDATION','APPROVED','ISSUED','PARTIALLY_PAID','PAID','CANCELLED'
  )) AS historical_noncanonical_statuses
FROM public.facture;
