-- #634 preflight — read-only and safe before the deployment window.
BEGIN TRANSACTION READ ONLY;

DO $guard$
BEGIN
  IF to_regclass('public.ged_access_events') IS NULL THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_PREFLIGHT_AUDIT_TABLE_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ged_access_events'::regclass
       AND conname = 'ged_access_events_event_type_check' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_PREFLIGHT_EVENT_TYPE_CONSTRAINT_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_access_events
     WHERE event_type NOT IN (
       'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
       'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
       'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE',
       'SCAN_PENDING', 'SCAN_CLEAN', 'SCAN_INFECTED', 'SCAN_FAILED',
       'QUARANTINED', 'QUARANTINE_RELEASED', 'QUARANTINE_DELETED',
       'AUTHORITATIVE_PDF_ARCHIVED', 'AUTHORITATIVE_PDF_PREVIEWED',
       'AUTHORITATIVE_PDF_DOWNLOADED', 'AUTHORITATIVE_PDF_PRINT_INTENT',
       'AUTHORITATIVE_PDF_SENT', 'CREATION_SNAPSHOT_ARCHIVED'
     )
  ) THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_PREFLIGHT_UNKNOWN_EXISTING_EVENT_TYPE';
  END IF;
END
$guard$;

SELECT
  to_regclass('public.ged_access_events') IS NOT NULL AS audit_table_present,
  EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ged_access_events'::regclass
       AND conname = 'ged_access_events_event_type_check' AND contype = 'c'
  ) AS event_type_constraint_present,
  NOT EXISTS (
    SELECT 1 FROM public.ged_access_events
     WHERE event_type NOT IN (
       'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
       'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
       'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE',
       'SCAN_PENDING', 'SCAN_CLEAN', 'SCAN_INFECTED', 'SCAN_FAILED',
       'QUARANTINED', 'QUARANTINE_RELEASED', 'QUARANTINE_DELETED',
       'AUTHORITATIVE_PDF_ARCHIVED', 'AUTHORITATIVE_PDF_PREVIEWED',
       'AUTHORITATIVE_PDF_DOWNLOADED', 'AUTHORITATIVE_PDF_PRINT_INTENT',
       'AUTHORITATIVE_PDF_SENT', 'CREATION_SNAPSHOT_ARCHIVED'
     )
  ) AS existing_evidence_representable;

COMMIT;
