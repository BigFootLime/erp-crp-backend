-- ROLLBACK for db/patches/20260710_project_office_core.sql
--
-- Retire ce qui a été ajouté (tables + enums neufs). Non destructif pour l'existant :
-- aucune table/colonne préexistante n'a été modifiée par la migration.
-- ⚠️ Détruit les DONNÉES Project Office éventuellement saisies — réservé à un rollback
-- assumé (prod : uniquement après décision humaine explicite + backup vérifié).
--   psql -d <db> -f db/patches/support/20260710_project_office_core.rollback.sql
-- NB : exécuter d'abord 20260710_project_office_report.rollback.sql si le patch report a été appliqué.

BEGIN;

-- Ordre inverse des dépendances (FK ON DELETE CASCADE facilitent, mais on reste explicite).
DROP TABLE IF EXISTS public.project_external_links;
DROP TABLE IF EXISTS public.project_activity_log;
DROP TABLE IF EXISTS public.project_comments;
DROP TABLE IF EXISTS public.project_corrective_actions;
DROP TABLE IF EXISTS public.project_evidence;
DROP TABLE IF EXISTS public.project_risks;
DROP TABLE IF EXISTS public.project_decisions;
-- FK circulaire specs<->versions : drop de la contrainte avant les tables.
ALTER TABLE IF EXISTS public.project_specs DROP CONSTRAINT IF EXISTS project_specs_current_version_fkey;
DROP TABLE IF EXISTS public.project_spec_versions;
DROP TABLE IF EXISTS public.project_specs;
DROP TABLE IF EXISTS public.project_milestones;
DROP TABLE IF EXISTS public.project_dependencies;
DROP TABLE IF EXISTS public.project_work_packages;
DROP TABLE IF EXISTS public.project_members;
DROP TABLE IF EXISTS public.project_projects;
DROP TABLE IF EXISTS public.app_feature_flag_users;
DROP TABLE IF EXISTS public.app_feature_flags;

-- Enums créés par la migration (après les tables qui les utilisent).
DROP TYPE IF EXISTS public.po_external_type;
DROP TYPE IF EXISTS public.po_link_provider;
DROP TYPE IF EXISTS public.po_evidence_type;
DROP TYPE IF EXISTS public.po_action_status;
DROP TYPE IF EXISTS public.po_action_source;
DROP TYPE IF EXISTS public.po_risk_status;
DROP TYPE IF EXISTS public.po_spec_status;
DROP TYPE IF EXISTS public.po_milestone_status;
DROP TYPE IF EXISTS public.po_dependency_type;
DROP TYPE IF EXISTS public.po_priority;
DROP TYPE IF EXISTS public.po_wp_status;
DROP TYPE IF EXISTS public.po_wp_type;
DROP TYPE IF EXISTS public.po_member_role;
DROP TYPE IF EXISTS public.po_project_status;
DROP TYPE IF EXISTS public.po_project_visibility;

-- Oublier le patch dans le registre du runner pour permettre une éventuelle ré-application.
DELETE FROM public.cerp_schema_migrations WHERE filename='20260710_project_office_core.sql';

COMMIT;
