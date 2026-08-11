-- SOL-11 verification — READ ONLY. Every boolean must be true after apply.
BEGIN TRANSACTION READ ONLY;

SELECT
  current_database() AS database,
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ged_upload_sessions' AND column_name = 'scan_status'
  ) AS scan_status_present,
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ged_upload_sessions' AND column_name = 'quarantine_status'
  ) AS quarantine_status_present,
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ged_document_versions' AND column_name = 'upload_session_id'
  ) AS version_session_link_present,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_version_requires_clean_scan') AS clean_scan_trigger,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_published_scan_immutable') AS immutable_scan_trigger,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_ged_upload_sessions_quarantine') AS quarantine_index,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_ged_version_upload_session') AS version_session_unique,
  NOT EXISTS (
    SELECT 1
      FROM public.ged_document_versions v
      JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
     WHERE s.scan_status <> 'clean'
  ) AS no_version_without_clean_verdict,
  NOT EXISTS (
    SELECT 1 FROM public.ged_upload_sessions
     WHERE quarantine_status = 'quarantined' AND quarantine_key IS NULL
  ) AS quarantine_keys_complete,
  (
    NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    OR has_table_privilege('cerp_app', 'public.ged_upload_sessions', 'SELECT,INSERT,UPDATE,DELETE')
  ) AS grants_ok;

COMMIT;
