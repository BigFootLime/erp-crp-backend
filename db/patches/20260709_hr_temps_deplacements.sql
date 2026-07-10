-- Module « Temps & Déplacements » (Pointage & Kilomètres) — T1 schéma de base.
-- Issue frontend #119 ; archi: crp-systems-web/docs/architecture/module-temps-pointage-kilometres.md ;
-- ADR-0013. Migration ADDITIVE + IDEMPOTENTE uniquement (aucun DROP, aucun changement de type).
-- Append-only de hr_time_events durci séparément par db/privileged/20260709_hr_time_events_append_only.sql
-- (owner/grants/triggers superuser). Aucun lien avec d'anciens fichiers. cerp_test d'abord.

DO $$ BEGIN EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'skip CREATE EXTENSION pgcrypto (privileges)'; END $$;

-- ------------------------------------------------------------------ Enums (gardés)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_employee_status') THEN CREATE TYPE public.hr_employee_status AS ENUM ('ACTIVE','SUSPENDED','LEFT'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_contract_type') THEN CREATE TYPE public.hr_contract_type AS ENUM ('H35','H39','PARTIAL','OTHER'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_device_status') THEN CREATE TYPE public.hr_device_status AS ENUM ('ACTIVE','DISABLED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_event_type') THEN CREATE TYPE public.hr_event_type AS ENUM ('IN','OUT','BREAK_START','BREAK_END','MISSION_START','MISSION_END'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_event_source') THEN CREATE TYPE public.hr_event_source AS ENUM ('BADGE','WEB','MOBILE','ADMIN','IMPORT'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_session_status') THEN CREATE TYPE public.hr_session_status AS ENUM ('OK','ANOMALY','MANUAL_REVIEW','VALIDATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_validation_status') THEN CREATE TYPE public.hr_validation_status AS ENUM ('DRAFT','TO_REVIEW','VALIDATED','EXPORTED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_adjustment_target') THEN CREATE TYPE public.hr_adjustment_target AS ENUM ('EVENT','DAY','WEEK'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_adjustment_status') THEN CREATE TYPE public.hr_adjustment_status AS ENUM ('REQUESTED','APPROVED','REJECTED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_anomaly_type') THEN CREATE TYPE public.hr_anomaly_type AS ENUM ('MISSING_IN','MISSING_OUT','MISSING_BREAK_END','DOUBLE_BADGE','TOO_LONG_DAY','TOO_SHORT_BREAK','OUTSIDE_SCHEDULE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_anomaly_severity') THEN CREATE TYPE public.hr_anomaly_severity AS ENUM ('INFO','WARNING','CRITICAL'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_vehicle_owner') THEN CREATE TYPE public.hr_vehicle_owner AS ENUM ('COMPANY','PERSONAL'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_km_type') THEN CREATE TYPE public.hr_km_type AS ENUM ('MISSION','CLIENT','FOURNISSEUR','LIVRAISON','AUTRE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_km_status') THEN CREATE TYPE public.hr_km_status AS ENUM ('DRAFT','SUBMITTED','VALIDATED','REJECTED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_export_format') THEN CREATE TYPE public.hr_export_format AS ENUM ('CSV','PDF'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='hr_export_status') THEN CREATE TYPE public.hr_export_status AS ENUM ('GENERATED','DELIVERED','SUPERSEDED'); END IF;
END $$;

-- ------------------------------------------------------------------ Référentiel employé & règles
CREATE TABLE IF NOT EXISTS public.hr_employees (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id integer NOT NULL,
  matricule text NOT NULL,
  service text NULL,
  manager_user_id integer NULL,
  status public.hr_employee_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_employees_pkey PRIMARY KEY (id),
  CONSTRAINT hr_employees_user_id_key UNIQUE (user_id),
  CONSTRAINT hr_employees_matricule_key UNIQUE (matricule),
  CONSTRAINT hr_employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT hr_employees_manager_user_id_fkey FOREIGN KEY (manager_user_id) REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS hr_employees_manager_idx ON public.hr_employees(manager_user_id) WHERE manager_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.hr_time_rule_sets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  weekly_target_minutes integer NOT NULL,
  daily_target_minutes integer NOT NULL,
  overtime_threshold_1_minutes integer NULL,
  overtime_rate_1 numeric(5,3) NULL,
  overtime_threshold_2_minutes integer NULL,
  overtime_rate_2 numeric(5,3) NULL,
  rounding_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  break_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_time_rule_sets_pkey PRIMARY KEY (id),
  CONSTRAINT hr_time_rule_sets_targets_ck CHECK (weekly_target_minutes >= 0 AND daily_target_minutes >= 0)
);

CREATE TABLE IF NOT EXISTS public.hr_employment_contracts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  contract_type public.hr_contract_type NOT NULL,
  weekly_hours_target numeric(6,2) NOT NULL,
  daily_hours_target numeric(5,2) NULL,
  start_date date NOT NULL,
  end_date date NULL,
  active boolean NOT NULL DEFAULT true,
  rule_set_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_employment_contracts_pkey PRIMARY KEY (id),
  CONSTRAINT hr_employment_contracts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  CONSTRAINT hr_employment_contracts_rule_set_id_fkey FOREIGN KEY (rule_set_id) REFERENCES public.hr_time_rule_sets(id) ON DELETE SET NULL,
  CONSTRAINT hr_employment_contracts_dates_ck CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS hr_employment_contracts_employee_idx ON public.hr_employment_contracts(employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_employment_contracts_one_active_idx ON public.hr_employment_contracts(employee_id) WHERE active;

CREATE TABLE IF NOT EXISTS public.hr_work_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  day_of_week integer NOT NULL,
  expected_start time NULL,
  expected_end time NULL,
  expected_break_minutes integer NOT NULL DEFAULT 0,
  flexible_start_window integer NOT NULL DEFAULT 0,
  flexible_end_window integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT hr_work_schedules_pkey PRIMARY KEY (id),
  CONSTRAINT hr_work_schedules_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  CONSTRAINT hr_work_schedules_dow_ck CHECK (day_of_week BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS hr_work_schedules_employee_idx ON public.hr_work_schedules(employee_id);

-- ------------------------------------------------------------------ Bornes & badges
CREATE TABLE IF NOT EXISTS public.hr_time_clock_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location text NULL,
  device_type text NULL,
  device_token_hash text NULL,
  status public.hr_device_status NOT NULL DEFAULT 'ACTIVE',
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_time_clock_devices_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.hr_badge_credentials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  badge_uid_hash text NOT NULL,
  badge_label text NULL,
  active boolean NOT NULL DEFAULT true,
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  CONSTRAINT hr_badge_credentials_pkey PRIMARY KEY (id),
  CONSTRAINT hr_badge_credentials_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_badge_credentials_active_uid_idx ON public.hr_badge_credentials(badge_uid_hash) WHERE active;

-- ------------------------------------------------------------------ Événements bruts (append-only ; hardening en db/privileged)
CREATE TABLE IF NOT EXISTS public.hr_time_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  device_id uuid NULL,
  event_type public.hr_event_type NOT NULL,
  event_time timestamptz NOT NULL,
  source public.hr_event_source NOT NULL DEFAULT 'WEB',
  idempotency_key text NULL,
  raw_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_time_events_pkey PRIMARY KEY (id),
  CONSTRAINT hr_time_events_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  CONSTRAINT hr_time_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.hr_time_clock_devices(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_time_events_idempotency_key_idx ON public.hr_time_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_time_events_employee_time_idx ON public.hr_time_events(employee_id, event_time);

-- ------------------------------------------------------------------ Agrégats calculés
CREATE TABLE IF NOT EXISTS public.hr_work_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  date date NOT NULL,
  start_time timestamptz NULL,
  end_time timestamptz NULL,
  break_minutes integer NOT NULL DEFAULT 0,
  worked_minutes integer NOT NULL DEFAULT 0,
  computed_from_events jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.hr_session_status NOT NULL DEFAULT 'OK',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_work_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT hr_work_sessions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hr_work_sessions_employee_date_idx ON public.hr_work_sessions(employee_id, date);

CREATE TABLE IF NOT EXISTS public.hr_timesheet_days (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  date date NOT NULL,
  expected_minutes integer NOT NULL DEFAULT 0,
  worked_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  missing_minutes integer NOT NULL DEFAULT 0,
  anomaly_count integer NOT NULL DEFAULT 0,
  validation_status public.hr_validation_status NOT NULL DEFAULT 'DRAFT',
  validated_by integer NULL,
  validated_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_timesheet_days_pkey PRIMARY KEY (id),
  CONSTRAINT hr_timesheet_days_employee_date_key UNIQUE (employee_id, date),
  CONSTRAINT hr_timesheet_days_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  CONSTRAINT hr_timesheet_days_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.hr_timesheet_weeks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  week_start date NOT NULL,
  week_end date NOT NULL,
  contract_minutes integer NOT NULL DEFAULT 0,
  worked_minutes integer NOT NULL DEFAULT 0,
  overtime_25_minutes integer NOT NULL DEFAULT 0,
  overtime_50_minutes integer NOT NULL DEFAULT 0,
  absence_minutes integer NOT NULL DEFAULT 0,
  validation_status public.hr_validation_status NOT NULL DEFAULT 'DRAFT',
  validated_by integer NULL,
  validated_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_timesheet_weeks_pkey PRIMARY KEY (id),
  CONSTRAINT hr_timesheet_weeks_employee_week_key UNIQUE (employee_id, week_start),
  CONSTRAINT hr_timesheet_weeks_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  CONSTRAINT hr_timesheet_weeks_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_timesheet_weeks_dates_ck CHECK (week_end >= week_start)
);

-- ------------------------------------------------------------------ Corrections & anomalies
CREATE TABLE IF NOT EXISTS public.hr_time_adjustments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  target_type public.hr_adjustment_target NOT NULL,
  target_id uuid NOT NULL,
  old_value_json jsonb NULL,
  new_value_json jsonb NULL,
  reason text NOT NULL,
  requested_by integer NOT NULL,
  approved_by integer NULL,
  status public.hr_adjustment_status NOT NULL DEFAULT 'REQUESTED',
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz NULL,
  CONSTRAINT hr_time_adjustments_pkey PRIMARY KEY (id),
  CONSTRAINT hr_time_adjustments_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT hr_time_adjustments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_time_adjustments_reason_ck CHECK (length(btrim(reason)) > 0),
  CONSTRAINT hr_time_adjustments_no_self_approve_ck CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS hr_time_adjustments_target_idx ON public.hr_time_adjustments(target_type, target_id);
CREATE INDEX IF NOT EXISTS hr_time_adjustments_status_idx ON public.hr_time_adjustments(status);

CREATE TABLE IF NOT EXISTS public.hr_time_anomalies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  date date NOT NULL,
  anomaly_type public.hr_anomaly_type NOT NULL,
  severity public.hr_anomaly_severity NOT NULL DEFAULT 'WARNING',
  message text NULL,
  resolved_by integer NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_time_anomalies_pkey PRIMARY KEY (id),
  CONSTRAINT hr_time_anomalies_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  CONSTRAINT hr_time_anomalies_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS hr_time_anomalies_employee_date_idx ON public.hr_time_anomalies(employee_id, date);

-- ------------------------------------------------------------------ Véhicules & kilomètres
CREATE TABLE IF NOT EXISTS public.hr_vehicles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  label text NOT NULL,
  plate text NULL,
  owner_type public.hr_vehicle_owner NOT NULL DEFAULT 'COMPANY',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_vehicles_pkey PRIMARY KEY (id)
);

-- Refs métier (affaire_id/client_id/fournisseur_id) volontairement SANS FK dure en T1
-- (couplage/typage à valider en T6-kilomètres) ; colonnes nullable = références souples.
CREATE TABLE IF NOT EXISTS public.hr_kilometer_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  date date NOT NULL,
  type public.hr_km_type NOT NULL DEFAULT 'MISSION',
  vehicle_id uuid NULL,
  start_location text NULL,
  end_location text NULL,
  start_odometer numeric(10,1) NULL,
  end_odometer numeric(10,1) NULL,
  distance_km numeric(10,2) NOT NULL DEFAULT 0,
  affaire_id bigint NULL,
  client_id integer NULL,
  fournisseur_id integer NULL,
  proof_document_id uuid NULL,
  status public.hr_km_status NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_by integer NULL,
  validated_at timestamptz NULL,
  CONSTRAINT hr_kilometer_entries_pkey PRIMARY KEY (id),
  CONSTRAINT hr_kilometer_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  CONSTRAINT hr_kilometer_entries_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.hr_vehicles(id) ON DELETE SET NULL,
  CONSTRAINT hr_kilometer_entries_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_kilometer_entries_distance_ck CHECK (distance_km >= 0)
);
CREATE INDEX IF NOT EXISTS hr_kilometer_entries_employee_date_idx ON public.hr_kilometer_entries(employee_id, date);

-- ------------------------------------------------------------------ Exports figés
CREATE TABLE IF NOT EXISTS public.hr_payroll_export_batches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_start date NOT NULL,
  period_end date NOT NULL,
  exported_by integer NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT now(),
  format public.hr_export_format NOT NULL,
  frozen_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum text NULL,
  supersedes_id uuid NULL,
  status public.hr_export_status NOT NULL DEFAULT 'GENERATED',
  CONSTRAINT hr_payroll_export_batches_pkey PRIMARY KEY (id),
  CONSTRAINT hr_payroll_export_batches_exported_by_fkey FOREIGN KEY (exported_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_export_batches_supersedes_fkey FOREIGN KEY (supersedes_id) REFERENCES public.hr_payroll_export_batches(id) ON DELETE SET NULL,
  CONSTRAINT hr_payroll_export_batches_period_ck CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS hr_payroll_export_batches_period_idx ON public.hr_payroll_export_batches(period_start, period_end);
