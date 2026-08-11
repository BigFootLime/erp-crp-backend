-- SOL-11 rollback. Refuses rollback once a SOL-11 upload session is linked to
-- a version; restore the coherent DB + GED recovery set in that case.
DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.migration_rehearsal', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: SOL-11 rollback is reserved for the isolated rehearsal database.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.ged_document_versions
     WHERE upload_session_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: SOL-11 document versions exist; restore the coherent DB + GED recovery set.';
  END IF;
END
$guard$;

BEGIN;

DROP TRIGGER IF EXISTS trg_ged_version_requires_clean_scan ON public.ged_document_versions;
DROP TRIGGER IF EXISTS trg_ged_published_scan_immutable ON public.ged_upload_sessions;
DROP FUNCTION IF EXISTS public.fn_ged_version_requires_clean_scan();
DROP FUNCTION IF EXISTS public.fn_ged_published_scan_immutable();
DROP INDEX IF EXISTS public.uq_ged_version_upload_session;
DROP INDEX IF EXISTS public.idx_ged_upload_sessions_quarantine;

ALTER TABLE public.ged_document_versions DROP COLUMN IF EXISTS upload_session_id;
ALTER TABLE public.ged_upload_sessions
  DROP COLUMN IF EXISTS request_metadata,
  DROP COLUMN IF EXISTS quarantine_key,
  DROP COLUMN IF EXISTS scanned_at,
  DROP COLUMN IF EXISTS scan_attempts,
  DROP COLUMN IF EXISTS scan_duration_ms,
  DROP COLUMN IF EXISTS signature_version,
  DROP COLUMN IF EXISTS scan_provider,
  DROP COLUMN IF EXISTS quarantine_status,
  DROP COLUMN IF EXISTS scan_status;

ALTER TABLE public.ged_access_events
  DROP CONSTRAINT IF EXISTS ged_access_events_event_type_check;
ALTER TABLE public.ged_access_events
  ADD CONSTRAINT ged_access_events_event_type_check CHECK (event_type IN (
    'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
    'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
    'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE'
  ));

COMMIT;
