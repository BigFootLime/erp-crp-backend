-- #634 rollback is strictly for the isolated migration rehearsal. It refuses
-- to discard any authoritative-PDF audit evidence; restore the coherent
-- database/GED backup to roll back a database that contains such evidence.
DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.migration_rehearsal', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_ROLLBACK_REFUSED_OUTSIDE_REHEARSAL';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ged_access_events
     WHERE event_type IN (
       'AUTHORITATIVE_PDF_ARCHIVED', 'AUTHORITATIVE_PDF_PREVIEWED',
       'AUTHORITATIVE_PDF_DOWNLOADED', 'AUTHORITATIVE_PDF_PRINT_INTENT',
       'AUTHORITATIVE_PDF_SENT', 'CREATION_SNAPSHOT_ARCHIVED'
     )
  ) THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_ROLLBACK_REFUSED_AUTHORITATIVE_EVIDENCE_EXISTS';
  END IF;
END
$guard$;

BEGIN;

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

COMMIT;
