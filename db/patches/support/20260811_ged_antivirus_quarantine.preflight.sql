-- SOL-11 preflight — READ ONLY. Every boolean must be true before apply.
BEGIN TRANSACTION READ ONLY;

SELECT
  current_database() AS database,
  current_setting('server_version_num')::integer >= 140000 AS postgres_version_supported,
  to_regclass('public.ged_upload_sessions') IS NOT NULL AS upload_sessions_present,
  to_regclass('public.ged_document_versions') IS NOT NULL AS versions_present,
  to_regclass('public.ged_access_events') IS NOT NULL AS audit_present,
  NOT EXISTS (
    SELECT 1
      FROM public.ged_upload_sessions
     WHERE status = 'PUBLISHED'
       AND (sha256 IS NULL OR sha256 !~ '^[a-f0-9]{64}$')
  ) AS published_sessions_have_hash,
  (SELECT COUNT(*) FROM public.ged_upload_sessions) AS existing_sessions,
  (SELECT COUNT(*) FROM public.ged_document_versions) AS existing_versions,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_role_present;

COMMIT;
