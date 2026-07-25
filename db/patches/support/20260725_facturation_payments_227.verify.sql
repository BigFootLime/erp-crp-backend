\set ON_ERROR_STOP on

-- Read-only verification for issue #227.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#227 verification is restricted to cerp_test';
  END IF;
  IF to_regclass('public.finance_billing_policies') IS NULL
     OR to_regclass('public.finance_legal_sequences') IS NULL
     OR to_regclass('public.facture_source_allocations') IS NULL
     OR to_regclass('public.avoir_source_allocations') IS NULL
     OR to_regclass('public.facture_echeance') IS NULL
     OR to_regclass('public.paiement_allocations') IS NULL
     OR to_regclass('public.finance_command_receipts') IS NULL
     OR to_regclass('public.finance_event_log') IS NULL
     OR to_regclass('public.finance_document_versions') IS NULL THEN
    RAISE EXCEPTION '#227 finance workflow objects are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_facture_immutable_227' AND tgrelid = 'public.facture'::regclass AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_avoir_immutable_227' AND tgrelid = 'public.avoir'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION '#227 issued-document immutability triggers are missing';
  END IF;
END $$;

SELECT count(*) FILTER (WHERE active) AS active_policy_count
FROM public.finance_billing_policies;

SELECT
  count(*) FILTER (WHERE statut = 'ISSUED' AND (legal_number IS NULL OR immutable_snapshot IS NULL OR document_checksum_sha256 IS NULL)) AS issued_factures_without_snapshot,
  count(*) FILTER (WHERE statut = 'ISSUED' AND issued_at IS NULL) AS issued_factures_without_timestamp
FROM public.facture;

SELECT
  count(*) FILTER (WHERE statut = 'ISSUED' AND (legal_number IS NULL OR immutable_snapshot IS NULL OR document_checksum_sha256 IS NULL)) AS issued_avoirs_without_snapshot
FROM public.avoir;

SELECT
  count(*) FILTER (WHERE source_total > delivered_quantity) AS overallocated_delivery_lines
FROM (
  SELECT a.source_line_id, SUM(a.quantity_consumed) AS source_total, bl.quantite AS delivered_quantity
  FROM public.facture_source_allocations a
  JOIN public.bon_livraison_ligne bl ON bl.id::text = a.source_line_id
  WHERE a.source_type = 'DELIVERY_LINE' AND a.allocation_status = 'CONSUMED'
  GROUP BY a.source_line_id, bl.quantite
) x;

SELECT
  count(*) FILTER (WHERE allocated_total > recorded_total) AS overallocated_payments
FROM (
  SELECT a.paiement_id, SUM(a.amount_ttc) AS allocated_total, p.montant AS recorded_total
  FROM public.paiement_allocations a
  JOIN public.paiement p ON p.id = a.paiement_id
  GROUP BY a.paiement_id, p.montant
) x;

SELECT
  (SELECT count(*) FROM public.finance_command_receipts) AS command_receipts,
  (SELECT count(*) FROM public.finance_event_log) AS finance_events,
  (SELECT count(*) FROM public.finance_document_versions) AS versioned_documents;
