\set ON_ERROR_STOP on

DO $verify$
DECLARE
  catalog_count integer;
  invalid_count bigint;
BEGIN
  SELECT count(*) INTO catalog_count
  FROM public.einvoice_billing_frame_catalog
  WHERE catalog_version = 'AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30';
  IF catalog_count <> 13 THEN
    RAISE EXCEPTION 'EINV-599 verification failed: expected 13 BT-23 codes, found %', catalog_count;
  END IF;
  IF to_regprocedure('public.fn_einvoice_reference_append_only_599()') IS NULL THEN
    RAISE EXCEPTION 'EINV-599 verification failed: append-only reference function is missing';
  END IF;
  IF to_regclass('public.einvoice_directory_verification_commands') IS NULL THEN
    RAISE EXCEPTION 'EINV-599 verification failed: directory verification command ledger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'facture_billing_frame_599_fk' AND conrelid = 'public.facture'::regclass
  ) THEN
    RAISE EXCEPTION 'EINV-599 verification failed: facture BT-23 foreign key is missing';
  END IF;
  SELECT count(*) INTO invalid_count
  FROM public.facture
  WHERE regulatory_snapshot IS NOT NULL
    AND (
      billing_frame_catalog_version IS NULL OR billing_frame_code IS NULL
      OR operation_category IS NULL OR transaction_scope IS NULL
      OR jsonb_typeof(regulatory_snapshot) <> 'object'
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'EINV-599 verification failed: % invalid regulatory invoice snapshot(s)', invalid_count;
  END IF;
END
$verify$;

SELECT catalog_version, code, operation_category, label_fr
FROM public.einvoice_billing_frame_catalog
ORDER BY catalog_version, code;

SELECT
  count(*) FILTER (WHERE regulatory_snapshot IS NOT NULL) AS qualified_invoice_count,
  count(*) FILTER (WHERE document_status = 'ISSUED' AND regulatory_snapshot IS NULL) AS historical_non_transmittable_count
FROM public.facture;
