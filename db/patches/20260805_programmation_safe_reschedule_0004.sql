-- GPT56-FEAT-CERP-0004 -- Safe, auditable programmation rescheduling.
--
-- Additive only: existing programmation dates are preserved.  The new model
-- adds optimistic versions and optional constraint references; no existing row
-- is reassigned, backfilled to a resource, or otherwise reinterpreted.

BEGIN;

DO $prerequisites$
BEGIN
  IF to_regclass('public.programmations') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.machines') IS NULL
     OR to_regclass('public.postes') IS NULL
     OR to_regclass('public.of_operations') IS NULL
     OR to_regclass('public.app_notifications') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regprocedure('public.tg_set_updated_at()') IS NULL
     OR to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004: prerequisite planning, production, audit, notification, or UUID object is missing';
  END IF;

  IF to_regclass('public.programmation_calendars') IS NOT NULL
     OR to_regclass('public.programmation_calendar_closures') IS NOT NULL
     OR to_regclass('public.programmation_user_skills') IS NOT NULL
     OR to_regclass('public.programmation_required_skills') IS NOT NULL
     OR to_regclass('public.programmation_dependencies') IS NOT NULL
     OR to_regclass('public.programmation_reschedule_operations') IS NOT NULL
     OR to_regclass('public.programmation_reschedule_events') IS NOT NULL
     OR to_regprocedure('public.fn_programmation_reschedule_event_immutable()') IS NOT NULL THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004: target artifact already exists without migration-ledger provenance';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'programmations'
      AND column_name = ANY (ARRAY[
        'version', 'machine_id', 'poste_id', 'of_operation_id',
        'calendar_id', 'required_machine_family_code'
      ])
  ) THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0004: target programmation column already exists without migration-ledger provenance';
  END IF;
END
$prerequisites$;

CREATE TABLE public.programmation_calendars (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  label text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  working_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  day_start time without time zone NOT NULL DEFAULT time '00:00',
  day_end time without time zone NOT NULL DEFAULT time '23:59:59.999999',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT programmation_calendars_pkey PRIMARY KEY (id),
  CONSTRAINT programmation_calendars_code_key UNIQUE (code),
  CONSTRAINT programmation_calendars_code_ck CHECK (btrim(code) <> ''),
  CONSTRAINT programmation_calendars_label_ck CHECK (btrim(label) <> ''),
  CONSTRAINT programmation_calendars_timezone_ck CHECK (btrim(timezone) <> ''),
  CONSTRAINT programmation_calendars_days_ck CHECK (
    cardinality(working_days) > 0
    AND working_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
  ),
  CONSTRAINT programmation_calendars_hours_ck CHECK (day_start <= day_end)
);

CREATE TABLE public.programmation_calendar_closures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES public.programmation_calendars(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT programmation_calendar_closures_pkey PRIMARY KEY (id),
  CONSTRAINT programmation_calendar_closures_dates_ck CHECK (start_date <= end_date),
  CONSTRAINT programmation_calendar_closures_reason_ck CHECK (btrim(reason) <> '')
);

CREATE TABLE public.programmation_user_skills (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  skill_code text NOT NULL,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT programmation_user_skills_pkey PRIMARY KEY (id),
  CONSTRAINT programmation_user_skills_scope_key UNIQUE (user_id, skill_code, valid_from),
  CONSTRAINT programmation_user_skills_code_ck CHECK (btrim(skill_code) <> ''),
  CONSTRAINT programmation_user_skills_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

ALTER TABLE public.programmations
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN machine_id uuid REFERENCES public.machines(id) ON DELETE SET NULL,
  ADD COLUMN poste_id uuid REFERENCES public.postes(id) ON DELETE SET NULL,
  ADD COLUMN of_operation_id uuid REFERENCES public.of_operations(id) ON DELETE SET NULL,
  ADD COLUMN calendar_id uuid REFERENCES public.programmation_calendars(id) ON DELETE SET NULL,
  ADD COLUMN required_machine_family_code text,
  ADD CONSTRAINT programmations_version_ck CHECK (version > 0),
  ADD CONSTRAINT programmations_machine_family_ck CHECK (
    required_machine_family_code IS NULL OR btrim(required_machine_family_code) <> ''
  );

CREATE TABLE public.programmation_required_skills (
  programmation_id uuid NOT NULL REFERENCES public.programmations(id) ON DELETE CASCADE,
  skill_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT programmation_required_skills_pkey PRIMARY KEY (programmation_id, skill_code),
  CONSTRAINT programmation_required_skills_code_ck CHECK (btrim(skill_code) <> '')
);

CREATE TABLE public.programmation_dependencies (
  predecessor_id uuid NOT NULL REFERENCES public.programmations(id) ON DELETE CASCADE,
  successor_id uuid NOT NULL REFERENCES public.programmations(id) ON DELETE CASCADE,
  dependency_type text NOT NULL DEFAULT 'FINISH_START',
  lag_days integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT programmation_dependencies_pkey PRIMARY KEY (predecessor_id, successor_id),
  CONSTRAINT programmation_dependencies_not_self_ck CHECK (predecessor_id <> successor_id),
  CONSTRAINT programmation_dependencies_type_ck CHECK (dependency_type = 'FINISH_START'),
  CONSTRAINT programmation_dependencies_lag_ck CHECK (lag_days >= 0 AND lag_days <= 3650)
);

CREATE TABLE public.programmation_reschedule_operations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  programmation_id uuid NOT NULL REFERENCES public.programmations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'APPLIED',
  request_idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  preview_token text NOT NULL,
  source text NOT NULL,
  timezone text NOT NULL,
  reason text NOT NULL,
  previous_state jsonb NOT NULL,
  next_state jsonb NOT NULL,
  applied_version integer NOT NULL,
  commit_response jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  cancel_idempotency_key text,
  cancel_fingerprint text,
  cancel_reason text,
  cancel_response jsonb,
  cancelled_at timestamptz,
  cancelled_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT programmation_reschedule_operations_pkey PRIMARY KEY (id),
  CONSTRAINT programmation_reschedule_operations_commit_key UNIQUE (programmation_id, request_idempotency_key),
  CONSTRAINT programmation_reschedule_operations_status_ck CHECK (status IN ('APPLIED','CANCELLED')),
  CONSTRAINT programmation_reschedule_operations_source_ck CHECK (source IN ('POINTER','KEYBOARD','TOUCH','API')),
  CONSTRAINT programmation_reschedule_operations_key_ck CHECK (
    char_length(request_idempotency_key) BETWEEN 8 AND 128
  ),
  CONSTRAINT programmation_reschedule_operations_hash_ck CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$' AND preview_token ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT programmation_reschedule_operations_reason_ck CHECK (
    char_length(btrim(reason)) BETWEEN 5 AND 1000
  ),
  CONSTRAINT programmation_reschedule_operations_version_ck CHECK (applied_version > 1),
  CONSTRAINT programmation_reschedule_operations_cancel_shape_ck CHECK (
    (status = 'APPLIED'
      AND cancel_idempotency_key IS NULL AND cancel_fingerprint IS NULL
      AND cancel_reason IS NULL AND cancel_response IS NULL
      AND cancelled_at IS NULL AND cancelled_by IS NULL)
    OR
    (status = 'CANCELLED'
      AND cancel_idempotency_key IS NOT NULL AND cancel_fingerprint IS NOT NULL
      AND cancel_reason IS NOT NULL AND cancel_response IS NOT NULL
      AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX programmation_reschedule_operations_cancel_key
  ON public.programmation_reschedule_operations(programmation_id, cancel_idempotency_key)
  WHERE cancel_idempotency_key IS NOT NULL;

CREATE TABLE public.programmation_reschedule_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.programmation_reschedule_operations(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  actor_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programmation_reschedule_events_pkey PRIMARY KEY (id),
  CONSTRAINT programmation_reschedule_events_type_ck CHECK (event_type IN ('COMMITTED','CANCELLED')),
  CONSTRAINT programmation_reschedule_events_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 5 AND 1000),
  CONSTRAINT programmation_reschedule_events_operation_type_key UNIQUE (operation_id, event_type)
);

CREATE OR REPLACE FUNCTION public.fn_programmation_reschedule_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
  RAISE EXCEPTION 'programmation_reschedule_events is append-only';
END
$immutable$;

CREATE TRIGGER programmation_reschedule_events_immutable
BEFORE UPDATE OR DELETE ON public.programmation_reschedule_events
FOR EACH ROW EXECUTE FUNCTION public.fn_programmation_reschedule_event_immutable();

CREATE TRIGGER programmation_calendars_set_updated_at
BEFORE UPDATE ON public.programmation_calendars
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE INDEX programmations_programmer_range_idx
  ON public.programmations(programmer_user_id, date_commencement, date_fin)
  WHERE programmer_user_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX programmations_machine_range_idx
  ON public.programmations(machine_id, date_commencement, date_fin)
  WHERE machine_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX programmations_poste_range_idx
  ON public.programmations(poste_id, date_commencement, date_fin)
  WHERE poste_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX programmations_operation_idx
  ON public.programmations(of_operation_id)
  WHERE of_operation_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX programmation_calendar_closures_range_idx
  ON public.programmation_calendar_closures(calendar_id, start_date, end_date);
CREATE INDEX programmation_user_skills_lookup_idx
  ON public.programmation_user_skills(user_id, skill_code, valid_from, valid_to)
  WHERE active;
CREATE INDEX programmation_dependencies_successor_idx
  ON public.programmation_dependencies(successor_id);
CREATE INDEX programmation_reschedule_operations_task_idx
  ON public.programmation_reschedule_operations(programmation_id, applied_at DESC);
CREATE INDEX programmation_reschedule_events_operation_idx
  ON public.programmation_reschedule_events(operation_id, created_at);

COMMENT ON COLUMN public.programmations.version IS
  'Optimistic concurrency version. Every committed reschedule or compensation increments it exactly once.';
COMMENT ON TABLE public.programmation_reschedule_operations IS
  'Idempotent safe-reschedule operation with exact before/after state and compensated cancellation state.';
COMMENT ON TABLE public.programmation_reschedule_events IS
  'Append-only audit evidence for committed and compensated programmation reschedules.';
COMMENT ON TABLE public.programmation_calendars IS
  'Optional authoritative working-day calendar. Unconfigured legacy tasks remain schedulable without invented capacity.';

COMMIT;
