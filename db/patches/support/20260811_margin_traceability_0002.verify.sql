\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  missing_columns integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260811_margin_traceability_0002.sql'
      AND sha256 = '8639afd24dfbf6ecd49131d2247c506ec1ca7acc17346bfdbacb61aaf6582d61'
  ) THEN
    RAISE EXCEPTION 'SOL-13 verify: canonical migration ledger entry is missing or has a different checksum';
  END IF;
  SELECT count(*) INTO missing_columns
  FROM unnest(ARRAY[
    'evidence_contract_version','definition','unit','period_start','period_end',
    'source_reliability','source_document_type','source_document_ref'
  ]) expected(column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = 'margin_input_versions'
      AND actual.column_name = expected.column_name
  );
  IF missing_columns <> 0 THEN
    RAISE EXCEPTION 'SOL-13 verify: % evidence columns are missing', missing_columns;
  END IF;
  IF 2 <> (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'margin_rate_versions'
      AND column_name IN ('evidence_contract_version','source_reliability')
  ) THEN
    RAISE EXCEPTION 'SOL-13 verify: rate evidence columns are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.margin_input_versions
    WHERE evidence_contract_version = 2
      AND (definition IS NULL OR unit IS NULL OR period_start IS NULL OR period_end IS NULL
        OR source_reliability NOT IN ('ESTIMATED','DECLARED','VERIFIED')
        OR (source_reliability = 'VERIFIED' AND (
          observed_at IS NULL OR source_document_type IS NULL OR btrim(source_document_type) = ''
          OR source_document_ref IS NULL OR btrim(source_document_ref) = ''
        )))
  ) THEN
    RAISE EXCEPTION 'SOL-13 verify: incomplete evidence v2 rows found';
  END IF;
END
$verify$;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.margin_rates'::regclass,
  'public.margin_input_versions'::regclass,
  'public.margin_recalculations'::regclass
)
  AND conname IN (
    'margin_rates_category_ck','margin_rate_versions_evidence_version_ck',
    'margin_rate_versions_source_reliability_ck','margin_input_versions_basis_ck',
    'margin_input_versions_category_ck','margin_input_versions_evidence_version_ck',
    'margin_input_versions_evidence_v2_ck','margin_recalculations_basis_ck'
  )
ORDER BY conname;

ROLLBACK;
