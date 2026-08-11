\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'));

DO $rollback_guard$
BEGIN
  IF current_database() NOT IN ('cerp_dev', 'cerp_test') THEN
    RAISE EXCEPTION 'SOL-13 rollback is restricted to cerp_dev/cerp_test; restore the pre-migration backup in production';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260811_margin_traceability_0002.sql'
      AND sha256 = '8639afd24dfbf6ecd49131d2247c506ec1ca7acc17346bfdbacb61aaf6582d61'
  ) THEN
    RAISE EXCEPTION 'SOL-13 rollback refused: canonical migration ledger entry is missing or differs';
  END IF;
  IF EXISTS (SELECT 1 FROM public.margin_input_versions WHERE evidence_contract_version = 2)
     OR EXISTS (SELECT 1 FROM public.margin_rate_versions WHERE evidence_contract_version = 2)
     OR EXISTS (SELECT 1 FROM public.margin_input_versions WHERE basis IN ('QUOTED','STANDARD','UPDATED'))
     OR EXISTS (SELECT 1 FROM public.margin_recalculations WHERE basis IN ('QUOTED','STANDARD','UPDATED'))
     OR EXISTS (SELECT 1 FROM public.margin_rates WHERE category = 'REWORK') THEN
    RAISE EXCEPTION 'SOL-13 rollback refused: v2 governed evidence exists; restore the pre-migration backup instead';
  END IF;
END
$rollback_guard$;

ALTER TABLE public.margin_rates
  DROP CONSTRAINT margin_rates_category_ck,
  ADD CONSTRAINT margin_rates_category_ck CHECK (category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','OVERHEAD'
  ));

ALTER TABLE public.margin_rate_versions
  DROP CONSTRAINT margin_rate_versions_evidence_version_ck,
  DROP CONSTRAINT margin_rate_versions_source_reliability_ck,
  DROP COLUMN source_reliability,
  DROP COLUMN evidence_contract_version;

ALTER TABLE public.margin_input_versions
  DROP CONSTRAINT margin_input_versions_basis_ck,
  DROP CONSTRAINT margin_input_versions_category_ck,
  DROP CONSTRAINT margin_input_versions_evidence_version_ck,
  DROP CONSTRAINT margin_input_versions_evidence_v2_ck,
  ADD CONSTRAINT margin_input_versions_basis_ck CHECK (basis IN ('PLANNED','ACTUAL')),
  ADD CONSTRAINT margin_input_versions_category_ck CHECK (category IS NULL OR category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','OVERHEAD'
  )),
  DROP COLUMN source_document_ref,
  DROP COLUMN source_document_type,
  DROP COLUMN source_reliability,
  DROP COLUMN period_end,
  DROP COLUMN period_start,
  DROP COLUMN unit,
  DROP COLUMN definition,
  DROP COLUMN evidence_contract_version;

ALTER TABLE public.margin_recalculations
  DROP CONSTRAINT margin_recalculations_basis_ck,
  ADD CONSTRAINT margin_recalculations_basis_ck CHECK (basis IN ('PLANNED','ACTUAL'));

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260811_margin_traceability_0002.sql'
  AND sha256 = '8639afd24dfbf6ecd49131d2247c506ec1ca7acc17346bfdbacb61aaf6582d61';

COMMIT;
