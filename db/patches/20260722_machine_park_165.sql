-- Issue #165 — Machine park, availability and maintenance governance.
-- Additive/idempotent repository patch. Apply to cerp_test only after preflight.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.machines') IS NULL
     OR to_regclass('public.production_machine_models') IS NULL
     OR to_regclass('public.planning_events') IS NULL
     OR to_regclass('public.production_machine_documents') IS NULL THEN
    RAISE EXCEPTION '#165 prerequisites missing: machines, production_machine_models, planning_events and production_machine_documents are required';
  END IF;
  IF to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION '#165 prerequisite missing: fn_next_issued_code_value(text)';
  END IF;
END $$;

-- Extend the existing non-reusable allocator whitelist with the stable machine scope.
CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|MCH|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope
      USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;

COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Whitelisted, non-reusable business-code allocator. #165 adds MCH for physical machines.';

-- A missing rate is materially different from a zero rate.
ALTER TABLE public.machines ALTER COLUMN hourly_rate DROP DEFAULT;
ALTER TABLE public.machines ALTER COLUMN hourly_rate DROP NOT NULL;
ALTER TABLE public.machines
  ADD COLUMN IF NOT EXISTS hourly_rate_source text NULL,
  ADD COLUMN IF NOT EXISTS hourly_rate_effective_at date NULL,
  ADD COLUMN IF NOT EXISTS hourly_rate_is_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legacy_alias text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machines_hourly_rate_source_ck'
      AND conrelid = 'public.machines'::regclass
  ) THEN
    ALTER TABLE public.machines
      ADD CONSTRAINT machines_hourly_rate_source_ck
      CHECK (hourly_rate_source IS NULL OR hourly_rate_source IN ('INTERNAL_COST', 'POSTE_INHERITED', 'IMPORTED', 'MANUAL_OVERRIDE', 'UNKNOWN'));
  END IF;
END $$;

UPDATE public.machines
SET hourly_rate_source = 'UNKNOWN'
WHERE hourly_rate IS NOT NULL
  AND hourly_rate_source IS NULL;

CREATE OR REPLACE FUNCTION public.fn_prevent_machine_code_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.code IS DISTINCT FROM NEW.code THEN
    RAISE EXCEPTION 'Machine code is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_machine_code_mutation ON public.machines;
CREATE TRIGGER trg_prevent_machine_code_mutation
BEFORE UPDATE OF code ON public.machines
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_machine_code_mutation();

CREATE TABLE IF NOT EXISTS public.production_machine_idempotence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_machine_idempotence_key_uq UNIQUE (idempotency_key),
  CONSTRAINT production_machine_idempotence_key_len CHECK (char_length(idempotency_key) BETWEEN 8 AND 200)
);

CREATE TABLE IF NOT EXISTS public.production_machine_maintenance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  frequency_days integer NULL,
  frequency_counter numeric(14,3) NULL,
  counter_unit text NULL,
  next_due_at date NULL,
  responsible_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  document_id uuid NULL REFERENCES public.production_machine_documents(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'internal',
  notes text NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  archived_at timestamptz NULL,
  archived_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT production_machine_maintenance_status_ck CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
  CONSTRAINT production_machine_maintenance_frequency_ck CHECK (frequency_days IS NULL OR frequency_days > 0),
  CONSTRAINT production_machine_maintenance_counter_ck CHECK (frequency_counter IS NULL OR frequency_counter > 0),
  CONSTRAINT production_machine_maintenance_checklist_ck CHECK (jsonb_typeof(checklist) = 'array')
);

CREATE TABLE IF NOT EXISTS public.production_machine_unavailability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  planning_event_id uuid NOT NULL REFERENCES public.planning_events(id) ON DELETE RESTRICT,
  cause text NOT NULL,
  comment text NULL,
  source text NOT NULL DEFAULT 'machine_park',
  maintenance_plan_id uuid NULL REFERENCES public.production_machine_maintenance_plans(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  archived_at timestamptz NULL,
  archived_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT production_machine_unavailability_event_uq UNIQUE (planning_event_id),
  CONSTRAINT production_machine_unavailability_cause_ck CHECK (cause IN (
    'PREVENTIVE_MAINTENANCE', 'BREAKDOWN', 'QUALIFICATION', 'RESERVATION',
    'WORKSHOP_CLOSURE', 'OPERATOR_ABSENCE', 'OTHER'
  ))
);

CREATE TABLE IF NOT EXISTS public.production_machine_maintenance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  maintenance_plan_id uuid NULL REFERENCES public.production_machine_maintenance_plans(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NULL,
  planning_event_id uuid NULL REFERENCES public.planning_events(id) ON DELETE SET NULL,
  unavailability_id uuid NULL REFERENCES public.production_machine_unavailability(id) ON DELETE SET NULL,
  checklist_result jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT production_machine_maintenance_event_type_ck CHECK (event_type IN ('SCHEDULED', 'STARTED', 'COMPLETED', 'CANCELLED', 'NOTE')),
  CONSTRAINT production_machine_maintenance_event_checklist_ck CHECK (jsonb_typeof(checklist_result) = 'array')
);

ALTER TABLE public.production_machine_documents
  ADD COLUMN IF NOT EXISTS revision text NULL,
  ADD COLUMN IF NOT EXISTS sha256 text NULL,
  ADD COLUMN IF NOT EXISTS mime_type text NULL,
  ADD COLUMN IF NOT EXISTS size_bytes bigint NULL,
  ADD COLUMN IF NOT EXISTS authored_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS removed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS removed_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.production_machine_documents
  DROP CONSTRAINT IF EXISTS production_machine_documents_type_ck;
ALTER TABLE public.production_machine_documents
  ADD CONSTRAINT production_machine_documents_type_ck CHECK (
    document_type IN ('OFFICIAL_PAGE', 'BROCHURE_PDF', 'MANUAL', 'IMAGE', 'RESALE_LISTING', 'INTERNAL_NOTE',
                      'CERTIFICATE', 'MAINTENANCE', 'PHOTO', 'MODEL_3D')
  );

CREATE INDEX IF NOT EXISTS production_machine_idempotence_machine_idx
  ON public.production_machine_idempotence(machine_id);
CREATE INDEX IF NOT EXISTS production_machine_maintenance_machine_due_idx
  ON public.production_machine_maintenance_plans(machine_id, next_due_at)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS production_machine_unavailability_machine_idx
  ON public.production_machine_unavailability(machine_id, created_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS production_machine_maintenance_events_machine_idx
  ON public.production_machine_maintenance_events(machine_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS production_machine_documents_active_idx
  ON public.production_machine_documents(machine_id, machine_model_id)
  WHERE removed_at IS NULL;

COMMENT ON TABLE public.production_machine_unavailability IS
  'Machine unavailability metadata. The canonical interval is the linked planning_events row.';
COMMENT ON TABLE public.production_machine_maintenance_events IS
  'Append-only maintenance history. Corrections are represented by a new event.';
COMMENT ON COLUMN public.machines.legacy_alias IS
  'Optional legacy/import alias; never used as a PK or FK.';

COMMIT;
