-- Module « Project Office / Pilotage projet » — schéma cœur + feature flags.
-- Issue frontend #130 ; archi : crp-systems-web/docs/architecture/module-project-office-macro-planning.md ;
-- ADR : crp-systems-web/docs/adr/ADR-project-office-macro-planning.md.
-- Migration ADDITIVE + IDEMPOTENTE uniquement (aucun DROP, aucun changement de type).
-- Feature gate : PROJECT_OFFICE désactivé par défaut (fail-closed) ; en prod, activation
-- par utilisateur pilote via app_feature_flag_users uniquement. cerp_test d'abord.
-- Verify : db/patches/support/20260710_project_office_core.verify.sql
-- Rollback : db/patches/support/20260710_project_office_core.rollback.sql

DO $$ BEGIN EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'skip CREATE EXTENSION pgcrypto (privileges)'; END $$;

-- ------------------------------------------------------------------ Enums (gardés)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_project_visibility') THEN CREATE TYPE public.po_project_visibility AS ENUM ('PRIVATE','INTERNAL','PILOT'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_project_status') THEN CREATE TYPE public.po_project_status AS ENUM ('DRAFT','ACTIVE','ON_HOLD','DONE','ARCHIVED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_member_role') THEN CREATE TYPE public.po_member_role AS ENUM ('OWNER','MANAGER','CONTRIBUTOR','VIEWER'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_wp_type') THEN CREATE TYPE public.po_wp_type AS ENUM ('EPIC','LOT','FEATURE','BUG','AUDIT','DOC','INFRA','SECURITY','COMPLIANCE','TASK'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_wp_status') THEN CREATE TYPE public.po_wp_status AS ENUM ('BACKLOG','READY','IN_PROGRESS','REVIEW','BLOCKED','DONE','CANCELLED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_priority') THEN CREATE TYPE public.po_priority AS ENUM ('LOW','NORMAL','HIGH','CRITICAL'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_dependency_type') THEN CREATE TYPE public.po_dependency_type AS ENUM ('BLOCKS','RELATES','DUPLICATES','REQUIRES'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_milestone_status') THEN CREATE TYPE public.po_milestone_status AS ENUM ('PLANNED','REACHED','MISSED','CANCELLED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_spec_status') THEN CREATE TYPE public.po_spec_status AS ENUM ('DRAFT','REVIEW','APPROVED','OBSOLETE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_risk_status') THEN CREATE TYPE public.po_risk_status AS ENUM ('OPEN','MITIGATED','ACCEPTED','CLOSED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_action_source') THEN CREATE TYPE public.po_action_source AS ENUM ('AUDIT','BUG','RISK','SECURITY','USER_FEEDBACK','OTHER'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_action_status') THEN CREATE TYPE public.po_action_status AS ENUM ('OPEN','IN_PROGRESS','DONE','CANCELLED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_evidence_type') THEN CREATE TYPE public.po_evidence_type AS ENUM ('PR','COMMIT','TEST','SCREENSHOT','AUDIT','DEPLOYMENT','BACKUP','DOCUMENT','SECURITY_SCAN','OTHER'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_link_provider') THEN CREATE TYPE public.po_link_provider AS ENUM ('GITHUB','GITLAB','OTHER'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_external_type') THEN CREATE TYPE public.po_external_type AS ENUM ('PR','ISSUE','COMMIT','PIPELINE','RELEASE','DOC'); END IF;
END $$;

-- ------------------------------------------------------------------ Feature flags (socle transverse)
CREATE TABLE IF NOT EXISTS public.app_feature_flags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  description text NULL,
  enabled boolean NOT NULL DEFAULT false, -- fail-closed : OFF par défaut
  environment text NOT NULL DEFAULT 'all',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_feature_flags_pkey PRIMARY KEY (id),
  CONSTRAINT app_feature_flags_key_key UNIQUE (key),
  CONSTRAINT app_feature_flags_environment_ck CHECK (environment IN ('all','production','test','development'))
);

CREATE TABLE IF NOT EXISTS public.app_feature_flag_users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  feature_flag_id uuid NOT NULL,
  user_id integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_feature_flag_users_pkey PRIMARY KEY (id),
  CONSTRAINT app_feature_flag_users_flag_user_key UNIQUE (feature_flag_id, user_id),
  CONSTRAINT app_feature_flag_users_flag_fkey FOREIGN KEY (feature_flag_id) REFERENCES public.app_feature_flags(id) ON DELETE CASCADE,
  CONSTRAINT app_feature_flag_users_user_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS app_feature_flag_users_user_idx ON public.app_feature_flag_users(user_id);

-- ------------------------------------------------------------------ Projets & membres
CREATE TABLE IF NOT EXISTS public.project_projects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text NULL,
  owner_id integer NOT NULL,
  visibility public.po_project_visibility NOT NULL DEFAULT 'PRIVATE',
  status public.po_project_status NOT NULL DEFAULT 'DRAFT',
  start_date date NULL,
  target_date date NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_projects_pkey PRIMARY KEY (id),
  CONSTRAINT project_projects_code_key UNIQUE (code),
  CONSTRAINT project_projects_owner_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT project_projects_dates_ck CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date)
);
CREATE INDEX IF NOT EXISTS project_projects_owner_idx ON public.project_projects(owner_id);
CREATE INDEX IF NOT EXISTS project_projects_status_idx ON public.project_projects(status);

CREATE TABLE IF NOT EXISTS public.project_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id integer NOT NULL,
  role public.po_member_role NOT NULL DEFAULT 'VIEWER',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_members_pkey PRIMARY KEY (id),
  CONSTRAINT project_members_project_user_key UNIQUE (project_id, user_id),
  CONSTRAINT project_members_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_members_user_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON public.project_members(user_id);

-- ------------------------------------------------------------------ Work packages (lots / tâches)
CREATE TABLE IF NOT EXISTS public.project_work_packages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  parent_id uuid NULL,
  code text NOT NULL,
  title text NOT NULL,
  description text NULL,
  type public.po_wp_type NOT NULL DEFAULT 'TASK',
  status public.po_wp_status NOT NULL DEFAULT 'BACKLOG',
  priority public.po_priority NOT NULL DEFAULT 'NORMAL',
  assignee_id integer NULL,
  reporter_id integer NULL,
  start_date date NULL,
  due_date date NULL,
  progress_percent integer NOT NULL DEFAULT 0,
  estimated_hours numeric(8,2) NULL,
  spent_hours numeric(8,2) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_work_packages_pkey PRIMARY KEY (id),
  CONSTRAINT project_work_packages_project_code_key UNIQUE (project_id, code),
  CONSTRAINT project_work_packages_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_work_packages_parent_fkey FOREIGN KEY (parent_id) REFERENCES public.project_work_packages(id) ON DELETE SET NULL,
  CONSTRAINT project_work_packages_assignee_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_work_packages_reporter_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_work_packages_progress_ck CHECK (progress_percent BETWEEN 0 AND 100),
  CONSTRAINT project_work_packages_not_self_parent_ck CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT project_work_packages_dates_ck CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)
);
CREATE INDEX IF NOT EXISTS project_work_packages_project_status_idx ON public.project_work_packages(project_id, status);
CREATE INDEX IF NOT EXISTS project_work_packages_assignee_idx ON public.project_work_packages(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_work_packages_parent_idx ON public.project_work_packages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_work_packages_due_idx ON public.project_work_packages(project_id, due_date) WHERE due_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.project_dependencies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_work_package_id uuid NOT NULL,
  target_work_package_id uuid NOT NULL,
  dependency_type public.po_dependency_type NOT NULL DEFAULT 'BLOCKS',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_dependencies_pkey PRIMARY KEY (id),
  CONSTRAINT project_dependencies_unique_key UNIQUE (source_work_package_id, target_work_package_id, dependency_type),
  CONSTRAINT project_dependencies_source_fkey FOREIGN KEY (source_work_package_id) REFERENCES public.project_work_packages(id) ON DELETE CASCADE,
  CONSTRAINT project_dependencies_target_fkey FOREIGN KEY (target_work_package_id) REFERENCES public.project_work_packages(id) ON DELETE CASCADE,
  CONSTRAINT project_dependencies_not_self_ck CHECK (source_work_package_id <> target_work_package_id)
);
CREATE INDEX IF NOT EXISTS project_dependencies_target_idx ON public.project_dependencies(target_work_package_id);

CREATE TABLE IF NOT EXISTS public.project_milestones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  name text NOT NULL,
  description text NULL,
  due_date date NULL,
  status public.po_milestone_status NOT NULL DEFAULT 'PLANNED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_milestones_pkey PRIMARY KEY (id),
  CONSTRAINT project_milestones_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_milestones_project_idx ON public.project_milestones(project_id, due_date);

-- ------------------------------------------------------------------ Cahier des charges versionné
CREATE TABLE IF NOT EXISTS public.project_specs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  title text NOT NULL,
  status public.po_spec_status NOT NULL DEFAULT 'DRAFT',
  current_version_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_specs_pkey PRIMARY KEY (id),
  CONSTRAINT project_specs_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_specs_project_idx ON public.project_specs(project_id);

CREATE TABLE IF NOT EXISTS public.project_spec_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  spec_id uuid NOT NULL,
  version text NOT NULL,
  content_markdown text NOT NULL,
  change_summary text NULL,
  author_id integer NOT NULL,
  approved_by integer NULL,
  approved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_spec_versions_pkey PRIMARY KEY (id),
  CONSTRAINT project_spec_versions_spec_version_key UNIQUE (spec_id, version),
  CONSTRAINT project_spec_versions_spec_fkey FOREIGN KEY (spec_id) REFERENCES public.project_specs(id) ON DELETE CASCADE,
  CONSTRAINT project_spec_versions_author_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT project_spec_versions_approver_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS project_spec_versions_spec_idx ON public.project_spec_versions(spec_id, created_at DESC);

-- FK circulaire specs.current_version_id -> spec_versions (ajoutée après coup, gardée)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_specs_current_version_fkey'
  ) THEN
    ALTER TABLE public.project_specs
      ADD CONSTRAINT project_specs_current_version_fkey
      FOREIGN KEY (current_version_id) REFERENCES public.project_spec_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ------------------------------------------------------------------ Décisions / risques / actions correctives
CREATE TABLE IF NOT EXISTS public.project_decisions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  title text NOT NULL,
  context text NULL,
  options_json jsonb NULL,
  decision text NOT NULL,
  consequences text NULL,
  decided_by integer NULL,
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT project_decisions_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_decisions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS project_decisions_project_idx ON public.project_decisions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.project_risks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  title text NOT NULL,
  description text NULL,
  probability integer NOT NULL,
  impact integer NOT NULL,
  severity integer GENERATED ALWAYS AS (probability * impact) STORED,
  mitigation text NULL,
  owner_id integer NULL,
  status public.po_risk_status NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_risks_pkey PRIMARY KEY (id),
  CONSTRAINT project_risks_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_risks_owner_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_risks_probability_ck CHECK (probability BETWEEN 1 AND 5),
  CONSTRAINT project_risks_impact_ck CHECK (impact BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS project_risks_project_idx ON public.project_risks(project_id, status);

-- ------------------------------------------------------------------ Preuves (avant actions : FK evidence_id)
CREATE TABLE IF NOT EXISTS public.project_evidence (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  work_package_id uuid NULL,
  type public.po_evidence_type NOT NULL DEFAULT 'OTHER',
  title text NOT NULL,
  url text NULL,
  description text NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_evidence_pkey PRIMARY KEY (id),
  CONSTRAINT project_evidence_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_evidence_wp_fkey FOREIGN KEY (work_package_id) REFERENCES public.project_work_packages(id) ON DELETE SET NULL,
  CONSTRAINT project_evidence_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_evidence_project_idx ON public.project_evidence(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_evidence_wp_idx ON public.project_evidence(work_package_id) WHERE work_package_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.project_corrective_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  source_type public.po_action_source NOT NULL DEFAULT 'OTHER',
  title text NOT NULL,
  description text NULL,
  priority public.po_priority NOT NULL DEFAULT 'NORMAL',
  owner_id integer NULL,
  due_date date NULL,
  status public.po_action_status NOT NULL DEFAULT 'OPEN',
  evidence_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_corrective_actions_pkey PRIMARY KEY (id),
  CONSTRAINT project_corrective_actions_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_corrective_actions_owner_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_corrective_actions_evidence_fkey FOREIGN KEY (evidence_id) REFERENCES public.project_evidence(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS project_corrective_actions_project_idx ON public.project_corrective_actions(project_id, status);

-- ------------------------------------------------------------------ Commentaires / activité / liens externes
CREATE TABLE IF NOT EXISTS public.project_comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_package_id uuid NOT NULL,
  author_id integer NOT NULL,
  body_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_comments_pkey PRIMARY KEY (id),
  CONSTRAINT project_comments_wp_fkey FOREIGN KEY (work_package_id) REFERENCES public.project_work_packages(id) ON DELETE CASCADE,
  CONSTRAINT project_comments_author_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_comments_wp_idx ON public.project_comments(work_package_id, created_at);

CREATE TABLE IF NOT EXISTS public.project_activity_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NULL,
  action text NOT NULL,
  actor_id integer NOT NULL,
  before_json jsonb NULL,
  after_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_activity_log_pkey PRIMARY KEY (id),
  CONSTRAINT project_activity_log_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_activity_log_actor_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_activity_log_project_idx ON public.project_activity_log(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_activity_log_entity_idx ON public.project_activity_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS public.project_external_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  entity_type text NOT NULL DEFAULT 'project',
  entity_id uuid NULL,
  provider public.po_link_provider NOT NULL DEFAULT 'GITHUB',
  external_type public.po_external_type NOT NULL DEFAULT 'PR',
  external_id text NULL,
  url text NOT NULL,
  status text NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_external_links_pkey PRIMARY KEY (id),
  CONSTRAINT project_external_links_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_external_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_external_links_project_idx ON public.project_external_links(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_external_links_entity_idx ON public.project_external_links(entity_type, entity_id);

-- ------------------------------------------------------------------ Ownership applicatif (aligné module hr)
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'app_feature_flags','app_feature_flag_users',
      'project_projects','project_members','project_work_packages','project_dependencies',
      'project_milestones','project_specs','project_spec_versions','project_decisions',
      'project_risks','project_evidence','project_corrective_actions','project_comments',
      'project_activity_log','project_external_links'
    ] LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', t);
    END LOOP;
  ELSE
    RAISE NOTICE 'role cerp_app absent — ownership inchangé';
  END IF;
END $$;
