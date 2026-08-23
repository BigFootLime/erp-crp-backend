-- #634 — align GED's durable audit-event whitelist with authoritative PDF flows.
-- This is deliberately additive: all SOL-11 antivirus and historical GED events
-- remain valid, and no existing audit evidence is rewritten or removed.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.ged_access_events') IS NULL THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_AUDIT_TABLE_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ged_access_events'::regclass
       AND conname = 'ged_access_events_event_type_check'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_EVENT_TYPE_CONSTRAINT_MISSING';
  END IF;
  -- A non-validated/custom prior constraint could have admitted evidence which
  -- the canonical contract does not understand. Refuse to make that evidence
  -- unrepresentable rather than silently changing its meaning.
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
    RAISE EXCEPTION 'GED_AUTHORITATIVE_EVENTS_634_UNKNOWN_EXISTING_EVENT_TYPE';
  END IF;
END
$guard$;

ALTER TABLE public.ged_access_events
  DROP CONSTRAINT IF EXISTS ged_access_events_event_type_check;
ALTER TABLE public.ged_access_events
  ADD CONSTRAINT ged_access_events_event_type_check CHECK (event_type IN (
    'UPLOAD', 'READ', 'DOWNLOAD', 'SUBMIT', 'APPROVE', 'REJECT',
    'PUBLISH', 'OBSOLETE', 'ARCHIVE', 'CHECKOUT', 'CHECKIN',
    'HOLD_PLACED', 'HOLD_RELEASED', 'INTEGRITY_FAILURE',
    'SCAN_PENDING', 'SCAN_CLEAN', 'SCAN_INFECTED', 'SCAN_FAILED',
    'QUARANTINED', 'QUARANTINE_RELEASED', 'QUARANTINE_DELETED',
    'AUTHORITATIVE_PDF_ARCHIVED', 'AUTHORITATIVE_PDF_PREVIEWED',
    'AUTHORITATIVE_PDF_DOWNLOADED', 'AUTHORITATIVE_PDF_PRINT_INTENT',
    'AUTHORITATIVE_PDF_SENT', 'CREATION_SNAPSHOT_ARCHIVED'
  ));

COMMIT;
