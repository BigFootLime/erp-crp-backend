-- 20260826_commande_ar_versioning_and_send_guard.sql
--
-- Immutable customer-order acknowledgement (AR) versions and safe delivery
-- state.  This patch is additive: existing generated PDFs remain attached to
-- their existing documents and are deterministically assigned a series and a
-- version.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.commande_ar_series_no_seq
  AS bigint
  MINVALUE 1
  START WITH 1;

CREATE TABLE IF NOT EXISTS public.commande_ar_series (
  commande_id BIGINT NOT NULL,
  series_number BIGINT NOT NULL,
  next_version_number INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commande_ar_series_pkey PRIMARY KEY (commande_id),
  CONSTRAINT commande_ar_series_number_uq UNIQUE (series_number),
  CONSTRAINT commande_ar_series_number_positive_chk CHECK (series_number > 0),
  CONSTRAINT commande_ar_series_next_version_positive_chk CHECK (next_version_number > 0)
);

DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'commande_ar_series_commande_id_fkey'
         AND conrelid = 'public.commande_ar_series'::regclass
     ) THEN
    ALTER TABLE public.commande_ar_series
      ADD CONSTRAINT commande_ar_series_commande_id_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE public.commande_ar_log
  ADD COLUMN IF NOT EXISTS ar_series_number BIGINT NULL,
  ADD COLUMN IF NOT EXISTS version_number INTEGER NULL,
  ADD COLUMN IF NOT EXISTS ar_reference TEXT NULL,
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS content_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS pdf_sha256 TEXT NULL,
  ADD COLUMN IF NOT EXISTS send_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS send_lock_token UUID NULL,
  ADD COLUMN IF NOT EXISTS send_idempotency_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS send_payload_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS provider_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS sent_email_subject TEXT NULL,
  ADD COLUMN IF NOT EXISTS sent_email_text TEXT NULL,
  ADD COLUMN IF NOT EXISTS sent_email_html TEXT NULL;

-- Backfill one stable series per existing order.  Ordering by generated_at and
-- UUID makes the assignment deterministic even when legacy rows share a time.
WITH first_log AS (
  SELECT DISTINCT ON (l.commande_id)
    l.commande_id,
    l.generated_at,
    l.id
  FROM public.commande_ar_log l
  ORDER BY l.commande_id, l.generated_at ASC, l.id ASC
), missing_series AS (
  SELECT
    f.commande_id,
    f.generated_at,
    f.id
  FROM first_log f
  LEFT JOIN public.commande_ar_series existing ON existing.commande_id = f.commande_id
  WHERE existing.commande_id IS NULL
), series_base AS (
  SELECT COALESCE(MAX(series_number), 0)::bigint AS value
  FROM public.commande_ar_series
), ordered_series AS (
  SELECT
    missing.commande_id,
    base.value + row_number() OVER (ORDER BY missing.generated_at ASC, missing.id ASC)::bigint AS series_number
  FROM missing_series missing
  CROSS JOIN series_base base
)
INSERT INTO public.commande_ar_series (commande_id, series_number, next_version_number)
SELECT commande_id, series_number, 1
FROM ordered_series
ON CONFLICT (commande_id) DO NOTHING;

-- Existing AR versions retain their original PDF/document.  Their business
-- version is ordered deterministically within the newly assigned series.
WITH numbered_logs AS (
  SELECT
    l.id,
    l.commande_id,
    row_number() OVER (
      PARTITION BY l.commande_id
      ORDER BY l.generated_at ASC, l.id ASC
    )::integer AS version_number
  FROM public.commande_ar_log l
)
UPDATE public.commande_ar_log l
SET
  ar_series_number = s.series_number,
  version_number = n.version_number,
  ar_reference = 'AR-' || lpad(s.series_number::text, 8, '0') || '-v' || n.version_number::text
FROM numbered_logs n
JOIN public.commande_ar_series s ON s.commande_id = n.commande_id
WHERE l.id = n.id
  AND (
    l.ar_series_number IS NULL
    OR l.version_number IS NULL
    OR l.ar_reference IS NULL
  );

UPDATE public.commande_ar_series s
SET
  next_version_number = GREATEST(
    1,
    COALESCE((
      SELECT MAX(l.version_number) + 1
      FROM public.commande_ar_log l
      WHERE l.commande_id = s.commande_id
    ), 1)
  ),
  updated_at = now();

SELECT setval(
  'public.commande_ar_series_no_seq',
  GREATEST(
    1::bigint,
    COALESCE((SELECT MAX(series_number) + 1 FROM public.commande_ar_series), 1::bigint)
  ),
  false
);

ALTER TABLE public.commande_ar_log
  ALTER COLUMN ar_series_number SET NOT NULL,
  ALTER COLUMN version_number SET NOT NULL,
  ALTER COLUMN ar_reference SET NOT NULL;

ALTER TABLE public.commande_ar_log
  DROP CONSTRAINT IF EXISTS commande_ar_log_status_check;

ALTER TABLE public.commande_ar_log
  ADD CONSTRAINT commande_ar_log_status_check
  CHECK (status IN ('GENERATED', 'SENDING', 'SENT', 'FAILED'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_series_positive_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_series_positive_chk CHECK (ar_series_number > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_version_positive_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_version_positive_chk CHECK (version_number > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_reference_nonempty_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_reference_nonempty_chk CHECK (btrim(ar_reference) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_content_fingerprint_format_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_content_fingerprint_format_chk CHECK (content_fingerprint IS NULL OR content_fingerprint ~ '^[A-Fa-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_pdf_sha256_format_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_pdf_sha256_format_chk CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[A-Fa-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_send_attempt_nonnegative_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_send_attempt_nonnegative_chk CHECK (send_attempt_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_ar_log_send_payload_fingerprint_format_chk' AND conrelid = 'public.commande_ar_log'::regclass) THEN
    ALTER TABLE public.commande_ar_log ADD CONSTRAINT commande_ar_log_send_payload_fingerprint_format_chk CHECK (send_payload_fingerprint IS NULL OR send_payload_fingerprint ~ '^[A-Fa-f0-9]{64}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS commande_ar_log_commande_version_uq
  ON public.commande_ar_log (commande_id, version_number);

CREATE UNIQUE INDEX IF NOT EXISTS commande_ar_log_reference_uq
  ON public.commande_ar_log (ar_reference);

CREATE INDEX IF NOT EXISTS commande_ar_log_commande_current_idx
  ON public.commande_ar_log (commande_id, version_number DESC);

CREATE INDEX IF NOT EXISTS commande_ar_log_send_in_progress_idx
  ON public.commande_ar_log (send_started_at)
  WHERE status = 'SENDING';

COMMIT;
