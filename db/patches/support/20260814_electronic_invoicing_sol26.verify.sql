\set ON_ERROR_STOP on

DO $verify$
DECLARE
  table_count integer;
  invalid_document_count bigint;
  invalid_event_count bigint;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'einvoice_provider_connections',
      'einvoice_documents',
      'einvoice_submission_attempts',
      'einvoice_provider_events',
      'einvoice_command_receipts'
    )
    AND c.relkind = 'r';
  IF table_count <> 5 THEN
    RAISE EXCEPTION 'SOL-26 verification failed: expected 5 tables, found %', table_count;
  END IF;

  IF to_regprocedure('public.fn_einvoice_evidence_append_only_sol26()') IS NULL THEN
    RAISE EXCEPTION 'SOL-26 verification failed: append-only evidence function is missing';
  END IF;

  SELECT COUNT(*) INTO invalid_document_count
  FROM public.einvoice_documents
  WHERE (external_status_code IS NOT NULL AND external_status_code NOT BETWEEN 200 AND 213)
     OR (direction = 'OUTBOUND' AND ((facture_id IS NOT NULL)::int + (avoir_id IS NOT NULL)::int) <> 1)
     OR source_sha256 !~ '^[0-9a-f]{64}$'
     OR (content_sha256 IS NOT NULL AND content_sha256 !~ '^[0-9a-f]{64}$')
     OR jsonb_typeof(attachment_metadata) <> 'array';
  IF invalid_document_count <> 0 THEN
    RAISE EXCEPTION 'SOL-26 verification failed: % invalid electronic-invoice document(s)', invalid_document_count;
  END IF;

  SELECT COUNT(*) INTO invalid_event_count
  FROM public.einvoice_provider_events
  WHERE external_status_code NOT BETWEEN 200 AND 213
     OR provider_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR signature_verified = false;
  IF invalid_event_count <> 0 THEN
    RAISE EXCEPTION 'SOL-26 verification failed: % invalid provider event(s)', invalid_event_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.einvoice_provider_connections
    WHERE enabled AND (qualified_at IS NULL OR qualified_by IS NULL)
  ) THEN
    RAISE EXCEPTION 'SOL-26 verification failed: an enabled connector is not qualified';
  END IF;
END
$verify$;

SELECT CASE WHEN COUNT(*) = 5 THEN true ELSE false END AS all_tables_present
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'einvoice_provider_connections',
    'einvoice_documents',
    'einvoice_submission_attempts',
    'einvoice_provider_events',
    'einvoice_command_receipts'
  )
  AND c.relkind = 'r';

SELECT
  COUNT(*) FILTER (WHERE external_status_code NOT BETWEEN 200 AND 213) AS invalid_status_count,
  COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND ((facture_id IS NOT NULL)::int + (avoir_id IS NOT NULL)::int) <> 1) AS invalid_outbound_source_count,
  COUNT(*) FILTER (WHERE source_sha256 !~ '^[0-9a-f]{64}$') AS invalid_source_hash_count,
  COUNT(*) FILTER (WHERE content_sha256 IS NOT NULL AND content_sha256 !~ '^[0-9a-f]{64}$') AS invalid_content_hash_count
FROM public.einvoice_documents;

SELECT
  COUNT(*) FILTER (WHERE signature_verified = false) AS failed_signature_verification_count,
  COUNT(*) FILTER (WHERE provider_payload_sha256 !~ '^[0-9a-f]{64}$') AS invalid_event_hash_count
FROM public.einvoice_provider_events;

SELECT provider_code, environment, enabled, supported_formats, qualified_at
FROM public.einvoice_provider_connections
ORDER BY provider_code;
