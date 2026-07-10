-- VERIFY db/patches/20260710_project_office_report.sql
--
-- À exécuter sur cerp_test (puis cerp_prod) après la migration. Prouve : 11 tables rapport
-- présentes et possédées par cerp_app, enums créés, uniques/FK en place, template Bac+5
-- seedable (le seed est séparé : db/seeds/project-office-report-template.sql).
--   sudo -u postgres psql -d cerp_test -f db/patches/support/20260710_project_office_report.verify.sql

\pset pager off

\echo '### tables rapport + owner (attendu: 11 lignes, owner cerp_app)'
SELECT tablename, tableowner FROM pg_tables
WHERE schemaname='public' AND tablename IN (
  'project_report_templates','project_report_sections','project_reports','project_report_entries',
  'project_report_assets','project_report_entry_evidence','project_report_versions',
  'project_report_exports','project_report_generation_runs','project_work_logs','project_error_records')
ORDER BY tablename;

\echo '### enums rapport (attendu: 10)'
SELECT count(*) AS report_enums FROM pg_type
WHERE typname IN ('po_report_level','po_report_status','po_entry_status','po_entry_evidence_relation',
  'po_asset_type','po_export_type','po_generation_mode','po_work_log_action','po_error_severity','po_error_status');

\echo '### uniques métier (attendu: template.code, (template,section_number), (report,section), (report,version))'
SELECT conrelid::regclass AS on_table, conname FROM pg_constraint
WHERE contype='u' AND conname IN (
  'project_report_templates_code_key','project_report_sections_template_number_key',
  'project_report_entries_report_section_key','project_report_versions_report_version_key')
ORDER BY conname;

\echo '### FK rapport (attendu: >= 20 lignes, dont entries→sections, entry_evidence→project_evidence)'
SELECT c.conrelid::regclass AS on_table, c.confrelid::regclass AS referenced_table, c.conname
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype='f' AND n.nspname='public'
  AND (r.relname LIKE 'project\_report%' OR r.relname IN ('project_work_logs','project_error_records'))
ORDER BY 1, 3;

\echo '### template Bac+5 (après seed : 1 ligne, 16 sections racines, 64 sous-parties)'
SELECT
  (SELECT count(*) FROM public.project_report_templates WHERE code='RAPPORT_BAC5_CERP')             AS template,
  (SELECT count(*) FROM public.project_report_sections s JOIN public.project_report_templates t
     ON t.id=s.template_id WHERE t.code='RAPPORT_BAC5_CERP' AND s.parent_id IS NULL)               AS sections_racines,
  (SELECT count(*) FROM public.project_report_sections s JOIN public.project_report_templates t
     ON t.id=s.template_id WHERE t.code='RAPPORT_BAC5_CERP' AND s.parent_id IS NOT NULL)           AS sous_parties;

\echo '### COMPAT — tables cœur Project Office toujours lisibles (aucune erreur = compatible)'
SELECT
  (SELECT count(*) FROM public.project_projects) AS projects,
  (SELECT count(*) FROM public.project_evidence) AS evidence;

\echo '### stockage DB captures/exports (attendu: 3 colonnes du patch report_files)'
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND (table_name, column_name) IN (
    ('project_report_assets', 'content_base64'),
    ('project_report_assets', 'checksum'),
    ('project_report_exports', 'file_base64'))
ORDER BY table_name, column_name;
