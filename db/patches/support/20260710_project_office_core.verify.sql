-- VERIFY db/patches/20260710_project_office_core.sql
--
-- À exécuter sur cerp_test (puis cerp_prod) après la migration. Prouve : 16 tables présentes,
-- possédées par cerp_app, enums créés, FK/uniques/checks en place, flag fail-closed,
-- ET compatibilité (users/erp_audit_logs intacts et lisibles).
--   sudo -u postgres psql -d cerp_test -f db/patches/support/20260710_project_office_core.verify.sql

\pset pager off

\echo '### tables Project Office core + owner (attendu: 16 lignes, owner cerp_app)'
SELECT tablename, tableowner FROM pg_tables
WHERE schemaname='public' AND tablename IN (
  'app_feature_flags','app_feature_flag_users',
  'project_projects','project_members','project_work_packages','project_dependencies',
  'project_milestones','project_specs','project_spec_versions','project_decisions',
  'project_risks','project_evidence','project_corrective_actions','project_comments',
  'project_activity_log','project_external_links')
ORDER BY tablename;

\echo '### enums po_* (attendu: 15)'
SELECT count(*) AS po_enums FROM pg_type
WHERE typname IN ('po_project_visibility','po_project_status','po_member_role','po_wp_type',
  'po_wp_status','po_priority','po_dependency_type','po_milestone_status','po_spec_status',
  'po_risk_status','po_action_source','po_action_status','po_evidence_type','po_link_provider','po_external_type');

\echo '### fail-closed : flag PROJECT_OFFICE (0 ligne = OFF par absence, ou enabled=false attendu en prod)'
SELECT key, enabled, environment FROM public.app_feature_flags WHERE key='PROJECT_OFFICE';

\echo '### activations par utilisateur du flag (prod attendu: 0 ou uniquement le pilote)'
SELECT ffu.user_id, ffu.enabled FROM public.app_feature_flag_users ffu
JOIN public.app_feature_flags ff ON ff.id=ffu.feature_flag_id WHERE ff.key='PROJECT_OFFICE';

\echo '### FK critiques (attendu: >= 24 lignes ; users référencé par owner/membre/auteur...)'
SELECT c.conrelid::regclass AS on_table, c.confrelid::regclass AS referenced_table, c.conname
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype='f' AND n.nspname='public'
  AND (r.relname LIKE 'project\_%' OR r.relname LIKE 'app\_feature\_flag%')
  AND r.relname NOT LIKE 'project\_report%' AND r.relname NOT IN ('project_work_logs','project_error_records')
ORDER BY 1, 3;

\echo '### checks anti-incohérence (attendu: progress 0-100, proba/impact 1-5, dep non-self, dates ordonnées)'
SELECT conrelid::regclass AS on_table, conname FROM pg_constraint
WHERE contype='c' AND conname IN (
  'project_work_packages_progress_ck','project_risks_probability_ck','project_risks_impact_ck',
  'project_dependencies_not_self_ck','project_work_packages_dates_ck','project_projects_dates_ck',
  'project_work_packages_not_self_parent_ck','app_feature_flags_environment_ck')
ORDER BY conname;

\echo '### severity générée = probability*impact (smoke transactionnel, aucune écriture persistée)'
BEGIN;
INSERT INTO public.project_projects (code, name, owner_id)
SELECT '__VERIFY_PO__', 'verify', u.id FROM public.users u ORDER BY u.id LIMIT 1;
INSERT INTO public.project_risks (project_id, title, probability, impact)
SELECT p.id, 'verify', 4, 5 FROM public.project_projects p WHERE p.code='__VERIFY_PO__';
SELECT probability, impact, severity AS severity_attendu_20 FROM public.project_risks r
JOIN public.project_projects p ON p.id=r.project_id WHERE p.code='__VERIFY_PO__';
ROLLBACK;

\echo '### COMPAT — tables existantes toujours lisibles (aucune erreur = compatible)'
SELECT
  (SELECT count(*) FROM public.users)          AS users,
  (SELECT count(*) FROM public.erp_audit_logs) AS audit_logs;
