-- SOL-11 — durable antivirus verdicts and quarantine for the central GED.
-- Additive for documents/blobs. Existing versions remain readable as
-- historical pre-SOL-11 rows (upload_session_id IS NULL).

BEGIN;

ALTER TABLE public.ged_upload_sessions
  ADD COLUMN IF NOT EXISTS scan_status text,
  ADD COLUMN IF NOT EXISTS quarantine_status text,
  ADD COLUMN IF NOT EXISTS scan_provider text,
  ADD COLUMN IF NOT EXISTS signature_version text,
  ADD COLUMN IF NOT EXISTS scan_duration_ms integer,
  ADD COLUMN IF NOT EXISTS scan_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_key text,
  ADD COLUMN IF NOT EXISTS request_metadata jsonb;

-- No previous runtime wrote these fields. Keep legacy sessions explicitly
-- pending instead of fabricating a clean verdict.
UPDATE public.ged_upload_sessions
   SET scan_status = COALESCE(scan_status, 'pending'),
       quarantine_status = COALESCE(quarantine_status, 'pending')
 WHERE scan_status IS NULL OR quarantine_status IS NULL;

ALTER TABLE public.ged_upload_sessions
  ALTER COLUMN scan_status SET DEFAULT 'pending',
  ALTER COLUMN scan_status SET NOT NULL,
  ALTER COLUMN quarantine_status SET DEFAULT 'pending',
  ALTER COLUMN quarantine_status SET NOT NULL;

ALTER TABLE public.ged_upload_sessions
  DROP CONSTRAINT IF EXISTS ged_upload_sessions_scan_status_check,
  ADD CONSTRAINT ged_upload_sessions_scan_status_check
    CHECK (scan_status IN ('pending', 'clean', 'infected', 'scan_failed')),
  DROP CONSTRAINT IF EXISTS ged_upload_sessions_quarantine_status_check,
  ADD CONSTRAINT ged_upload_sessions_quarantine_status_check
    CHECK (quarantine_status IN ('pending', 'quarantined', 'released', 'deleted')),
  DROP CONSTRAINT IF EXISTS ged_upload_sessions_scan_duration_check,
  ADD CONSTRAINT ged_upload_sessions_scan_duration_check
    CHECK (scan_duration_ms IS NULL OR scan_duration_ms >= 0),
  DROP CONSTRAINT IF EXISTS ged_upload_sessions_scan_attempts_check,
  ADD CONSTRAINT ged_upload_sessions_scan_attempts_check
    CHECK (scan_attempts >= 0),
  DROP CONSTRAINT IF EXISTS ged_upload_sessions_quarantine_key_check,
  ADD CONSTRAINT ged_upload_sessions_quarantine_key_check
    CHECK (
      (quarantine_status = 'quarantined' AND quarantine_key IS NOT NULL)
      OR (quarantine_status <> 'quarantined')
    );

CREATE INDEX IF NOT EXISTS idx_ged_upload_sessions_quarantine
  ON public.ged_upload_sessions(quarantine_status, scan_status, created_at)
  WHERE quarantine_status = 'quarantined';

ALTER TABLE public.ged_document_versions
  ADD COLUMN IF NOT EXISTS upload_session_id uuid NULL
    REFERENCES public.ged_upload_sessions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ged_version_upload_session
  ON public.ged_document_versions(upload_session_id)
  WHERE upload_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_ged_version_requires_clean_scan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  verdict text;
BEGIN
  IF NEW.upload_session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT scan_status INTO verdict
    FROM public.ged_upload_sessions
   WHERE id = NEW.upload_session_id;

  IF verdict IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION 'GED_SCAN_REQUIRED: version publication refused without a clean antivirus verdict (session=%)', NEW.upload_session_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_version_requires_clean_scan ON public.ged_document_versions;
CREATE TRIGGER trg_ged_version_requires_clean_scan
  BEFORE INSERT OR UPDATE OF upload_session_id ON public.ged_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_version_requires_clean_scan();

CREATE OR REPLACE FUNCTION public.fn_ged_published_scan_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND (
       NEW.scan_status IS DISTINCT FROM OLD.scan_status
       OR NEW.quarantine_status IS DISTINCT FROM OLD.quarantine_status
       OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR (OLD.quarantine_key IS NULL AND NEW.quarantine_key IS NOT NULL)
       OR (
         OLD.quarantine_key IS NOT NULL
         AND NEW.quarantine_key IS NOT NULL
         AND NEW.quarantine_key IS DISTINCT FROM OLD.quarantine_key
       )
     ) THEN
    RAISE EXCEPTION 'GED_SCAN_IMMUTABLE: a published scan verdict cannot be changed (session=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_published_scan_immutable ON public.ged_upload_sessions;
CREATE TRIGGER trg_ged_published_scan_immutable
  BEFORE UPDATE ON public.ged_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_published_scan_immutable();

ALTER TABLE public.ged_access_events
  DROP CONSTRAINT IF EXISTS ged_access_events_event_type_check;
ALTER TABLE public.ged_access_events
  ADD CONSTRAINT ged_access_events_event_type_check CHECK (event_type IN (
    'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
    'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
    'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE',
    'SCAN_PENDING', 'SCAN_CLEAN', 'SCAN_INFECTED', 'SCAN_FAILED',
    'QUARANTINED', 'QUARANTINE_RELEASED', 'QUARANTINE_DELETED'
  ));

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ged_upload_sessions TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
