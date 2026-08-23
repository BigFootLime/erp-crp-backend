-- #634 verification — read-only proof that all historical and new audit events are allowed.
BEGIN TRANSACTION READ ONLY;

DO $guard$
DECLARE
  definition text;
  required_event text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
    FROM pg_constraint
   WHERE conrelid = 'public.ged_access_events'::regclass
     AND conname = 'ged_access_events_event_type_check' AND contype = 'c';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_VERIFY_EVENT_TYPE_CONSTRAINT_MISSING';
  END IF;
  FOREACH required_event IN ARRAY ARRAY[
    'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
    'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
    'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE',
    'SCAN_PENDING', 'SCAN_CLEAN', 'SCAN_INFECTED', 'SCAN_FAILED',
    'QUARANTINED', 'QUARANTINE_RELEASED', 'QUARANTINE_DELETED',
    'AUTHORITATIVE_PDF_ARCHIVED', 'AUTHORITATIVE_PDF_PREVIEWED',
    'AUTHORITATIVE_PDF_DOWNLOADED', 'AUTHORITATIVE_PDF_PRINT_INTENT',
    'AUTHORITATIVE_PDF_SENT', 'CREATION_SNAPSHOT_ARCHIVED'
  ] LOOP
    IF position(quote_literal(required_event) IN definition) = 0 THEN
      RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_VERIFY_EVENT_TYPE_MISSING:%', required_event;
    END IF;
  END LOOP;
END
$guard$;

SELECT
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
  ) AS all_audit_evidence_representable,
  EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ged_access_events'::regclass
       AND conname = 'ged_access_events_event_type_check' AND contype = 'c'
  ) AS event_type_constraint_present;

COMMIT;
