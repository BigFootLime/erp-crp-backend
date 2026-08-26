-- Read-only verification for 20260826_commande_ar_versioning_and_send_guard.sql.
BEGIN TRANSACTION READ ONLY;

DO $$
BEGIN
  IF to_regclass('public.commande_ar_series') IS NULL THEN
    RAISE EXCEPTION 'Missing public.commande_ar_series';
  END IF;
  IF to_regclass('public.commande_ar_series_no_seq') IS NULL THEN
    RAISE EXCEPTION 'Missing public.commande_ar_series_no_seq';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commande_ar_log'
      AND column_name IN (
        'ar_series_number', 'version_number', 'ar_reference', 'content_fingerprint',
        'content_snapshot', 'pdf_sha256', 'send_attempt_count', 'send_started_at',
        'send_lock_token', 'send_idempotency_key', 'send_payload_fingerprint',
        'provider_name', 'sent_email_subject', 'sent_email_text', 'sent_email_html'
      )
    GROUP BY table_schema, table_name
    HAVING count(*) = 15
  ) THEN
    RAISE EXCEPTION 'Commande AR versioning columns are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.commande_ar_log
    WHERE ar_series_number IS NULL OR version_number IS NULL OR ar_reference IS NULL
  ) THEN
    RAISE EXCEPTION 'Commande AR backfill is incomplete';
  END IF;
  IF EXISTS (
    SELECT commande_id, version_number
    FROM public.commande_ar_log
    GROUP BY commande_id, version_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate AR version detected';
  END IF;
END $$;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'commande_ar_log_commande_version_uq',
    'commande_ar_log_reference_uq',
    'commande_ar_log_commande_current_idx',
    'commande_ar_log_send_in_progress_idx'
  )
ORDER BY indexname;

SELECT status, count(*)::bigint
FROM public.commande_ar_log
GROUP BY status
ORDER BY status;

ROLLBACK;
