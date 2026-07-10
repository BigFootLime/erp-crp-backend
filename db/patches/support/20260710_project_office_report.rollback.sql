-- ROLLBACK for db/patches/20260710_project_office_report.sql
--
-- Retire ce qui a été ajouté (tables + enums rapport). Non destructif pour l'existant.
-- ⚠️ Détruit les DONNÉES du sous-module Rapport — réservé à un rollback assumé
-- (prod : uniquement après décision humaine explicite + backup vérifié).
--   psql -d <db> -f db/patches/support/20260710_project_office_report.rollback.sql

BEGIN;

DROP TABLE IF EXISTS public.project_error_records;
DROP TABLE IF EXISTS public.project_work_logs;
DROP TABLE IF EXISTS public.project_report_generation_runs;
DROP TABLE IF EXISTS public.project_report_exports;
-- FK circulaire reports<->versions : drop de la contrainte avant les tables.
ALTER TABLE IF EXISTS public.project_reports DROP CONSTRAINT IF EXISTS project_reports_current_version_fkey;
DROP TABLE IF EXISTS public.project_report_versions;
DROP TABLE IF EXISTS public.project_report_entry_evidence;
DROP TABLE IF EXISTS public.project_report_assets;
DROP TABLE IF EXISTS public.project_report_entries;
DROP TABLE IF EXISTS public.project_reports;
DROP TABLE IF EXISTS public.project_report_sections;
DROP TABLE IF EXISTS public.project_report_templates;

DROP TYPE IF EXISTS public.po_error_status;
DROP TYPE IF EXISTS public.po_error_severity;
DROP TYPE IF EXISTS public.po_work_log_action;
DROP TYPE IF EXISTS public.po_generation_mode;
DROP TYPE IF EXISTS public.po_export_type;
DROP TYPE IF EXISTS public.po_asset_type;
DROP TYPE IF EXISTS public.po_entry_evidence_relation;
DROP TYPE IF EXISTS public.po_entry_status;
DROP TYPE IF EXISTS public.po_report_status;
DROP TYPE IF EXISTS public.po_report_level;

DELETE FROM public.cerp_schema_migrations WHERE filename='20260710_project_office_report.sql';
DELETE FROM public.cerp_schema_migrations WHERE filename='20260710_project_office_report_files.sql';

COMMIT;
