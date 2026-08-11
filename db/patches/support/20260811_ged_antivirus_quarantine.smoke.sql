-- SOL-11 destructive-free schema smoke for an isolated database only.
-- All proof rows are rolled back at the end of the session.
BEGIN;

INSERT INTO public.ged_upload_sessions
  (id, class_key, status, sha256, size_bytes, mime_type, original_name,
   expires_at, scan_status, quarantine_status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'PLAN_CLIENT', 'QUARANTINE',
   repeat('a', 64), 68, 'text/plain', 'eicar.txt', now() + interval '1 day',
   'pending', 'pending');

INSERT INTO public.ged_blobs
  (id, sha256, size_bytes, mime_type, storage_key)
VALUES
  ('22222222-2222-4222-8222-222222222222', repeat('a', 64), 68,
   'text/plain', 'vault/sha256/aa/aa/test');

INSERT INTO public.ged_documents
  (id, code, class_key, title)
VALUES
  ('33333333-3333-4333-8333-333333333333', 'GED-SOL11-SMOKE',
   'PLAN_CLIENT', 'SOL-11 isolated smoke');

DO $pending_is_blocked$
BEGIN
  BEGIN
    INSERT INTO public.ged_document_versions
      (id, document_id, version_number, status, blob_id, original_name, upload_session_id)
    VALUES
      ('44444444-4444-4444-8444-444444444444',
       '33333333-3333-4333-8333-333333333333', 1, 'BROUILLON',
       '22222222-2222-4222-8222-222222222222', 'eicar.txt',
       '11111111-1111-4111-8111-111111111111');
    RAISE EXCEPTION 'SOL11_SMOKE_FAILED: pending verdict was published';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'GED_SCAN_REQUIRED:%' THEN
      RAISE;
    END IF;
  END;
END
$pending_is_blocked$;

UPDATE public.ged_upload_sessions
   SET scan_status = 'clean', quarantine_status = 'quarantined',
       quarantine_key = 'quarantine/11111111-1111-4111-8111-111111111111.quarantine',
       scan_provider = 'clamdscan', signature_version = 'ClamAV isolated-smoke',
       scan_duration_ms = 1, scanned_at = now()
 WHERE id = '11111111-1111-4111-8111-111111111111';

INSERT INTO public.ged_document_versions
  (id, document_id, version_number, status, blob_id, original_name, upload_session_id)
VALUES
  ('44444444-4444-4444-8444-444444444444',
   '33333333-3333-4333-8333-333333333333', 1, 'BROUILLON',
   '22222222-2222-4222-8222-222222222222', 'eicar.txt',
   '11111111-1111-4111-8111-111111111111');

UPDATE public.ged_upload_sessions
   SET status = 'PUBLISHED', quarantine_status = 'released'
 WHERE id = '11111111-1111-4111-8111-111111111111';

-- Post-commit cleanup may clear the private path but cannot alter the verdict.
UPDATE public.ged_upload_sessions
   SET quarantine_key = NULL
 WHERE id = '11111111-1111-4111-8111-111111111111';

DO $published_is_immutable$
BEGIN
  BEGIN
    UPDATE public.ged_upload_sessions
       SET scan_status = 'infected'
     WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'SOL11_SMOKE_FAILED: published verdict was mutable';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'GED_SCAN_IMMUTABLE:%' THEN
      RAISE;
    END IF;
  END;
END
$published_is_immutable$;

SELECT
  EXISTS (
    SELECT 1
      FROM public.ged_document_versions v
      JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
     WHERE v.id = '44444444-4444-4444-8444-444444444444'
       AND s.scan_status = 'clean'
       AND s.status = 'PUBLISHED'
       AND s.quarantine_key IS NULL
  ) AS clean_version_published,
  NOT EXISTS (
    SELECT 1 FROM public.ged_upload_sessions
     WHERE id = '11111111-1111-4111-8111-111111111111'
       AND scan_status <> 'clean'
  ) AS published_verdict_immutable;

ROLLBACK;
