-- Guarded rollback for 20260826_commande_ar_versioning_and_send_guard.sql.
-- AR history is legally/business-significant.  This rollback only runs on an
-- empty AR journal and always requires an explicit human approval setting.
BEGIN;

DO $$
BEGIN
  IF current_setting('cerp.confirm_commande_ar_versioning_rollback', true) IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'Set cerp.confirm_commande_ar_versioning_rollback=APPROVED after human validation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commande_ar_log) THEN
    RAISE EXCEPTION 'Rollback refused: commande_ar_log contains historical AR records';
  END IF;
END $$;

DROP INDEX IF EXISTS public.commande_ar_log_send_in_progress_idx;
DROP INDEX IF EXISTS public.commande_ar_log_commande_current_idx;
DROP INDEX IF EXISTS public.commande_ar_log_reference_uq;
DROP INDEX IF EXISTS public.commande_ar_log_commande_version_uq;

ALTER TABLE public.commande_ar_log
  DROP CONSTRAINT IF EXISTS commande_ar_log_send_payload_fingerprint_format_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_send_attempt_nonnegative_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_pdf_sha256_format_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_content_fingerprint_format_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_reference_nonempty_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_version_positive_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_series_positive_chk,
  DROP CONSTRAINT IF EXISTS commande_ar_log_status_check;

ALTER TABLE public.commande_ar_log
  ADD CONSTRAINT commande_ar_log_status_check
  CHECK (status IN ('GENERATED', 'SENT', 'FAILED'));

ALTER TABLE public.commande_ar_log
  DROP COLUMN IF EXISTS sent_email_html,
  DROP COLUMN IF EXISTS sent_email_text,
  DROP COLUMN IF EXISTS sent_email_subject,
  DROP COLUMN IF EXISTS provider_name,
  DROP COLUMN IF EXISTS send_payload_fingerprint,
  DROP COLUMN IF EXISTS send_idempotency_key,
  DROP COLUMN IF EXISTS send_lock_token,
  DROP COLUMN IF EXISTS send_started_at,
  DROP COLUMN IF EXISTS send_attempt_count,
  DROP COLUMN IF EXISTS pdf_sha256,
  DROP COLUMN IF EXISTS content_snapshot,
  DROP COLUMN IF EXISTS content_fingerprint,
  DROP COLUMN IF EXISTS ar_reference,
  DROP COLUMN IF EXISTS version_number,
  DROP COLUMN IF EXISTS ar_series_number;

DROP TABLE IF EXISTS public.commande_ar_series;
DROP SEQUENCE IF EXISTS public.commande_ar_series_no_seq;

COMMIT;
