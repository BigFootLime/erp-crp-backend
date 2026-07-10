-- Module « Project Office » — sous-module Rapport de projet (Bac+5).
-- Issue frontend #130 ; dépend de 20260710_project_office_core.sql (project_projects, project_evidence).
-- Migration ADDITIVE + IDEMPOTENTE uniquement (aucun DROP, aucun changement de type).
-- Le contenu généré est TOUJOURS marqué BROUILLON_IA et lié à des preuves ; jamais de texte inventé.
-- Verify : db/patches/support/20260710_project_office_report.verify.sql
-- Rollback : db/patches/support/20260710_project_office_report.rollback.sql

-- ------------------------------------------------------------------ Enums (gardés)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_report_level') THEN CREATE TYPE public.po_report_level AS ENUM ('BAC_PLUS_3','BAC_PLUS_5','INTERNE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_report_status') THEN CREATE TYPE public.po_report_status AS ENUM ('DRAFT','IN_PROGRESS','REVIEW','APPROVED','EXPORTED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_entry_status') THEN CREATE TYPE public.po_entry_status AS ENUM ('VIDE','A_DOCUMENTER','BROUILLON_IA','A_RELIRE','VALIDE','A_RETRAVAILLER','EXPORTE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_entry_evidence_relation') THEN CREATE TYPE public.po_entry_evidence_relation AS ENUM ('SOURCE','SCREENSHOT','TEST','BUG','FIX','DECISION','DEPLOYMENT','ARCHITECTURE','UI','SECURITY'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_asset_type') THEN CREATE TYPE public.po_asset_type AS ENUM ('SCREENSHOT','ERROR_SCREENSHOT','UI_SCREENSHOT','DIAGRAM','LOG_EXTRACT','TEST_RESULT','OTHER'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_export_type') THEN CREATE TYPE public.po_export_type AS ENUM ('SECTION_DOCX','FULL_DOCX','PDF','MARKDOWN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_generation_mode') THEN CREATE TYPE public.po_generation_mode AS ENUM ('AUTO_FROM_EVIDENCE','MANUAL_REGENERATE','FULL_REPORT'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_work_log_action') THEN CREATE TYPE public.po_work_log_action AS ENUM ('BRANCH_CREATED','CODE_CHANGE','BUG_FOUND','BUG_FIXED','TEST_RUN','DEPLOYMENT','MIGRATION','REVIEW','DOCUMENTATION','SCREENSHOT'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_error_severity') THEN CREATE TYPE public.po_error_severity AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='po_error_status') THEN CREATE TYPE public.po_error_status AS ENUM ('OPEN','FIXED','WONT_FIX','DUPLICATE'); END IF;
END $$;

-- ------------------------------------------------------------------ Modèles de rapport
CREATE TABLE IF NOT EXISTS public.project_report_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  title text NOT NULL,
  description text NULL,
  level public.po_report_level NOT NULL DEFAULT 'BAC_PLUS_5',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_templates_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_templates_code_key UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS public.project_report_sections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  parent_id uuid NULL,
  section_number text NOT NULL,
  title text NOT NULL,
  description text NULL,
  expected_content text NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_sections_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_sections_template_number_key UNIQUE (template_id, section_number),
  CONSTRAINT project_report_sections_template_fkey FOREIGN KEY (template_id) REFERENCES public.project_report_templates(id) ON DELETE CASCADE,
  CONSTRAINT project_report_sections_parent_fkey FOREIGN KEY (parent_id) REFERENCES public.project_report_sections(id) ON DELETE CASCADE,
  CONSTRAINT project_report_sections_not_self_parent_ck CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS project_report_sections_template_idx ON public.project_report_sections(template_id, display_order);
CREATE INDEX IF NOT EXISTS project_report_sections_parent_idx ON public.project_report_sections(parent_id) WHERE parent_id IS NOT NULL;

-- ------------------------------------------------------------------ Rapports
CREATE TABLE IF NOT EXISTS public.project_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  template_id uuid NOT NULL,
  title text NOT NULL,
  author_id integer NOT NULL,
  academic_year text NULL,
  status public.po_report_status NOT NULL DEFAULT 'DRAFT',
  current_version_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_reports_pkey PRIMARY KEY (id),
  CONSTRAINT project_reports_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_reports_template_fkey FOREIGN KEY (template_id) REFERENCES public.project_report_templates(id) ON DELETE RESTRICT,
  CONSTRAINT project_reports_author_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_reports_project_idx ON public.project_reports(project_id);

CREATE TABLE IF NOT EXISTS public.project_report_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  section_id uuid NOT NULL,
  status public.po_entry_status NOT NULL DEFAULT 'VIDE',
  progress_percent integer NOT NULL DEFAULT 0,
  ai_draft_markdown text NULL,
  validated_markdown text NULL,
  manual_notes text NULL,
  last_generated_at timestamptz NULL,
  validated_by integer NULL,
  validated_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_entries_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_entries_report_section_key UNIQUE (report_id, section_id),
  CONSTRAINT project_report_entries_report_fkey FOREIGN KEY (report_id) REFERENCES public.project_reports(id) ON DELETE CASCADE,
  CONSTRAINT project_report_entries_section_fkey FOREIGN KEY (section_id) REFERENCES public.project_report_sections(id) ON DELETE CASCADE,
  CONSTRAINT project_report_entries_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_report_entries_progress_ck CHECK (progress_percent BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS project_report_entries_report_idx ON public.project_report_entries(report_id);

-- ------------------------------------------------------------------ Captures / assets (avant erreurs : FK screenshot)
CREATE TABLE IF NOT EXISTS public.project_report_assets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  report_entry_id uuid NULL,
  file_id uuid NULL, -- réservé : rattachement futur à un stockage fichier central
  title text NOT NULL,
  description text NULL,
  asset_type public.po_asset_type NOT NULL DEFAULT 'SCREENSHOT',
  storage_path text NULL,
  mime_type text NULL,
  width integer NULL,
  height integer NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_assets_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_assets_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_report_assets_entry_fkey FOREIGN KEY (report_entry_id) REFERENCES public.project_report_entries(id) ON DELETE SET NULL,
  CONSTRAINT project_report_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_report_assets_project_idx ON public.project_report_assets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_report_assets_entry_idx ON public.project_report_assets(report_entry_id) WHERE report_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.project_report_entry_evidence (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_entry_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  relation_type public.po_entry_evidence_relation NOT NULL DEFAULT 'SOURCE',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_entry_evidence_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_entry_evidence_unique_key UNIQUE (report_entry_id, evidence_id, relation_type),
  CONSTRAINT project_report_entry_evidence_entry_fkey FOREIGN KEY (report_entry_id) REFERENCES public.project_report_entries(id) ON DELETE CASCADE,
  CONSTRAINT project_report_entry_evidence_evidence_fkey FOREIGN KEY (evidence_id) REFERENCES public.project_evidence(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_report_entry_evidence_evidence_idx ON public.project_report_entry_evidence(evidence_id);

-- ------------------------------------------------------------------ Versions / exports / générations
CREATE TABLE IF NOT EXISTS public.project_report_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_markdown text NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_versions_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_versions_report_version_key UNIQUE (report_id, version),
  CONSTRAINT project_report_versions_report_fkey FOREIGN KEY (report_id) REFERENCES public.project_reports(id) ON DELETE CASCADE,
  CONSTRAINT project_report_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
);

-- FK circulaire reports.current_version_id -> report_versions (ajoutée après coup, gardée)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_reports_current_version_fkey'
  ) THEN
    ALTER TABLE public.project_reports
      ADD CONSTRAINT project_reports_current_version_fkey
      FOREIGN KEY (current_version_id) REFERENCES public.project_report_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.project_report_exports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  version_id uuid NULL,
  export_type public.po_export_type NOT NULL,
  section_id uuid NULL,
  file_path text NOT NULL,
  checksum text NOT NULL,
  exported_by integer NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_exports_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_exports_report_fkey FOREIGN KEY (report_id) REFERENCES public.project_reports(id) ON DELETE CASCADE,
  CONSTRAINT project_report_exports_version_fkey FOREIGN KEY (version_id) REFERENCES public.project_report_versions(id) ON DELETE SET NULL,
  CONSTRAINT project_report_exports_section_fkey FOREIGN KEY (section_id) REFERENCES public.project_report_sections(id) ON DELETE SET NULL,
  CONSTRAINT project_report_exports_exported_by_fkey FOREIGN KEY (exported_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_report_exports_report_idx ON public.project_report_exports(report_id, exported_at DESC);

CREATE TABLE IF NOT EXISTS public.project_report_generation_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  section_id uuid NULL,
  triggered_by integer NOT NULL,
  mode public.po_generation_mode NOT NULL DEFAULT 'AUTO_FROM_EVIDENCE',
  input_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_report_generation_runs_pkey PRIMARY KEY (id),
  CONSTRAINT project_report_generation_runs_report_fkey FOREIGN KEY (report_id) REFERENCES public.project_reports(id) ON DELETE CASCADE,
  CONSTRAINT project_report_generation_runs_section_fkey FOREIGN KEY (section_id) REFERENCES public.project_report_sections(id) ON DELETE SET NULL,
  CONSTRAINT project_report_generation_runs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_report_generation_runs_report_idx ON public.project_report_generation_runs(report_id, created_at DESC);

-- ------------------------------------------------------------------ Journal de travail & erreurs (auto-documentation)
CREATE TABLE IF NOT EXISTS public.project_work_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  work_package_id uuid NULL,
  branch_name text NULL,
  pr_url text NULL,
  commit_sha text NULL,
  module text NULL,
  action_type public.po_work_log_action NOT NULL DEFAULT 'CODE_CHANGE',
  title text NOT NULL,
  description text NULL,
  before_state text NULL,
  after_state text NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_work_logs_pkey PRIMARY KEY (id),
  CONSTRAINT project_work_logs_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_work_logs_wp_fkey FOREIGN KEY (work_package_id) REFERENCES public.project_work_packages(id) ON DELETE SET NULL,
  CONSTRAINT project_work_logs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_work_logs_project_idx ON public.project_work_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_work_logs_action_idx ON public.project_work_logs(project_id, action_type);

CREATE TABLE IF NOT EXISTS public.project_error_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  work_package_id uuid NULL,
  title text NOT NULL,
  error_message text NULL,
  context text NULL,
  screenshot_asset_id uuid NULL,
  severity public.po_error_severity NOT NULL DEFAULT 'MEDIUM',
  status public.po_error_status NOT NULL DEFAULT 'OPEN',
  fix_summary text NULL,
  fixed_by integer NULL,
  fixed_at timestamptz NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_error_records_pkey PRIMARY KEY (id),
  CONSTRAINT project_error_records_project_fkey FOREIGN KEY (project_id) REFERENCES public.project_projects(id) ON DELETE CASCADE,
  CONSTRAINT project_error_records_wp_fkey FOREIGN KEY (work_package_id) REFERENCES public.project_work_packages(id) ON DELETE SET NULL,
  CONSTRAINT project_error_records_screenshot_fkey FOREIGN KEY (screenshot_asset_id) REFERENCES public.project_report_assets(id) ON DELETE SET NULL,
  CONSTRAINT project_error_records_fixed_by_fkey FOREIGN KEY (fixed_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_error_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_error_records_project_idx ON public.project_error_records(project_id, status);

-- ------------------------------------------------------------------ Ownership applicatif (aligné module hr)
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'project_report_templates','project_report_sections','project_reports','project_report_entries',
      'project_report_assets','project_report_entry_evidence','project_report_versions',
      'project_report_exports','project_report_generation_runs','project_work_logs','project_error_records'
    ] LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', t);
    END LOOP;
  ELSE
    RAISE NOTICE 'role cerp_app absent — ownership inchangé';
  END IF;
END $$;
