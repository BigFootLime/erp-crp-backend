-- SOL-24 — Affaires, Project Office, temps et déplacements.
-- Migration additive et rejouable. Aucune donnée métier n'est fabriquée.
-- Preflight : support/20260814_project_operations_sol24.preflight.sql
-- Vérification : support/20260814_project_operations_sol24.verify.sql
-- Rollback test uniquement : support/20260814_project_operations_sol24.rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.project_budget_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.project_projects(id) ON DELETE CASCADE,
  amount numeric(18,6) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'EUR',
  effective_from date NOT NULL,
  effective_to date NULL,
  definition text NOT NULL,
  source_type text NOT NULL,
  source_ref text NULL,
  observed_at timestamptz NOT NULL,
  reliability text NOT NULL,
  supersedes_id uuid NULL REFERENCES public.project_budget_versions(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_budget_versions_amount_0462_ck CHECK (amount >= 0),
  CONSTRAINT project_budget_versions_currency_0462_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT project_budget_versions_period_0462_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT project_budget_versions_definition_0462_ck CHECK (char_length(btrim(definition)) >= 5),
  CONSTRAINT project_budget_versions_source_0462_ck CHECK (source_type IN ('DECLARATION','CONTRACT','DOCUMENT','OTHER')),
  CONSTRAINT project_budget_versions_reliability_0462_ck CHECK (reliability IN ('DECLARED','VERIFIED','ESTIMATED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS project_budget_versions_current_0462_uq
  ON public.project_budget_versions(project_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS project_budget_versions_project_period_0462_idx
  ON public.project_budget_versions(project_id, effective_from DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.project_affaire_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.project_projects(id) ON DELETE CASCADE,
  affaire_id bigint NOT NULL REFERENCES public.affaire(id) ON DELETE RESTRICT,
  source_ref text NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_affaire_links_project_affaire_0462_uq UNIQUE (project_id, affaire_id)
);
CREATE INDEX IF NOT EXISTS project_affaire_links_affaire_0462_idx
  ON public.project_affaire_links(affaire_id);

CREATE TABLE IF NOT EXISTS public.hr_absence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  absence_date date NOT NULL,
  minutes integer NOT NULL,
  absence_type text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  status text NOT NULL DEFAULT 'REQUESTED',
  reason text NOT NULL,
  source_ref text NULL,
  requested_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_absence_records_minutes_0462_ck CHECK (minutes > 0 AND minutes <= 1440),
  CONSTRAINT hr_absence_records_type_0462_ck CHECK (absence_type IN ('PAID_LEAVE','SICK_LEAVE','RTT','TRAINING','OTHER')),
  CONSTRAINT hr_absence_records_status_0462_ck CHECK (status IN ('REQUESTED','APPROVED','REJECTED','CANCELLED')),
  CONSTRAINT hr_absence_records_reason_0462_ck CHECK (char_length(btrim(reason)) >= 3),
  CONSTRAINT hr_absence_records_decision_0462_ck CHECK (
    (status = 'REQUESTED' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR status = 'CANCELLED'
  )
);
CREATE INDEX IF NOT EXISTS hr_absence_records_employee_date_0462_idx
  ON public.hr_absence_records(employee_id, absence_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS hr_absence_records_active_0462_uq
  ON public.hr_absence_records(employee_id, absence_date, absence_type)
  WHERE status IN ('REQUESTED','APPROVED');

CREATE TABLE IF NOT EXISTS public.hr_period_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL,
  period_end date NOT NULL,
  employee_id uuid NULL REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  status text NOT NULL DEFAULT 'CLOSED',
  reason text NOT NULL,
  closed_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  closed_at timestamptz NOT NULL DEFAULT now(),
  reopened_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reopened_at timestamptz NULL,
  CONSTRAINT hr_period_closures_period_0462_ck CHECK (period_end >= period_start),
  CONSTRAINT hr_period_closures_status_0462_ck CHECK (status IN ('CLOSED','REOPENED')),
  CONSTRAINT hr_period_closures_reason_0462_ck CHECK (char_length(btrim(reason)) >= 5),
  CONSTRAINT hr_period_closures_reopen_0462_ck CHECK (
    (status = 'CLOSED' AND reopened_by IS NULL AND reopened_at IS NULL)
    OR (status = 'REOPENED' AND reopened_by IS NOT NULL AND reopened_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS hr_period_closures_active_0462_idx
  ON public.hr_period_closures(period_start, period_end, employee_id) WHERE status = 'CLOSED';

CREATE TABLE IF NOT EXISTS public.hr_kilometer_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type public.hr_vehicle_owner NOT NULL,
  rate_per_km numeric(12,6) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'EUR',
  effective_from date NOT NULL,
  effective_to date NULL,
  definition text NOT NULL,
  source_type text NOT NULL,
  source_ref text NULL,
  observed_at timestamptz NOT NULL,
  reliability text NOT NULL,
  supersedes_id uuid NULL REFERENCES public.hr_kilometer_rate_versions(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_kilometer_rate_versions_rate_0462_ck CHECK (rate_per_km >= 0),
  CONSTRAINT hr_kilometer_rate_versions_currency_0462_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT hr_kilometer_rate_versions_period_0462_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT hr_kilometer_rate_versions_definition_0462_ck CHECK (char_length(btrim(definition)) >= 5),
  CONSTRAINT hr_kilometer_rate_versions_source_0462_ck CHECK (source_type IN ('DECLARATION','LEGAL_SCALE','CONTRACT','OTHER')),
  CONSTRAINT hr_kilometer_rate_versions_reliability_0462_ck CHECK (reliability IN ('DECLARED','VERIFIED','ESTIMATED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_kilometer_rate_versions_current_0462_uq
  ON public.hr_kilometer_rate_versions(owner_type) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS hr_kilometer_rate_versions_period_0462_idx
  ON public.hr_kilometer_rate_versions(owner_type, effective_from DESC);

ALTER TABLE public.hr_kilometer_entries
  ADD COLUMN IF NOT EXISTS rate_version_id uuid NULL REFERENCES public.hr_kilometer_rate_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cost_amount numeric(18,6) NULL,
  ADD COLUMN IF NOT EXISTS cost_currency char(3) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_kilometer_entries_cost_0462_ck') THEN
    ALTER TABLE public.hr_kilometer_entries
      ADD CONSTRAINT hr_kilometer_entries_cost_0462_ck CHECK (
        (cost_amount IS NULL AND cost_currency IS NULL AND rate_version_id IS NULL)
        OR (cost_amount IS NOT NULL AND cost_amount >= 0 AND cost_currency ~ '^[A-Z]{3}$' AND rate_version_id IS NOT NULL)
      );
  END IF;
END $$;

COMMIT;
