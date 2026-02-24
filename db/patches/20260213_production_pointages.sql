-- 20260213_production_pointages.sql
-- Production: Suivi production / Pointages
--
-- Adds:
-- - public.production_pointages (time entries)
-- - public.production_pointage_events (append-only event log)
--
-- Notes:
-- - Uses gen_random_uuid() => requires pgcrypto.
-- - Uses public.tg_set_updated_at() if present (already used by other patches).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'production_pointage_time_type') THEN
    CREATE TYPE production_pointage_time_type AS ENUM ('OPERATEUR', 'MACHINE', 'PROGRAMMATION');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'production_pointage_status') THEN
    CREATE TYPE production_pointage_status AS ENUM ('RUNNING', 'DONE', 'CANCELLED', 'CORRECTED');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.production_pointages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  of_id bigint NOT NULL
    REFERENCES public.ordres_fabrication(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  affaire_id bigint NULL
    REFERENCES public.affaire(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  piece_technique_id uuid NULL
    REFERENCES public.pieces_techniques(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  operation_id uuid NULL
    REFERENCES public.of_operations(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  machine_id uuid NULL
    REFERENCES public.machines(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  poste_id uuid NULL
    REFERENCES public.postes(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  operator_user_id integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  time_type production_pointage_time_type NOT NULL,

  start_ts timestamptz NOT NULL,
  end_ts timestamptz NULL,
  duration_minutes integer NULL,

  status production_pointage_status NOT NULL DEFAULT 'RUNNING',

  comment text NULL,
  correction_reason text NULL,

  validated_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  validated_at timestamptz NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT production_pointages_start_end_chk CHECK (end_ts IS NULL OR end_ts >= start_ts),
  CONSTRAINT production_pointages_running_end_chk CHECK (status <> 'RUNNING' OR end_ts IS NULL),
  CONSTRAINT production_pointages_end_required_chk CHECK (status = 'RUNNING' OR end_ts IS NOT NULL),
  CONSTRAINT production_pointages_correction_reason_chk CHECK (status <> 'CORRECTED' OR correction_reason IS NOT NULL),
  CONSTRAINT production_pointages_validation_pair_chk CHECK ((validated_at IS NULL) = (validated_by IS NULL))
);

CREATE OR REPLACE FUNCTION public.tg_set_production_pointage_duration_minutes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.start_ts IS NOT NULL AND NEW.end_ts IS NOT NULL THEN
    NEW.duration_minutes := GREATEST(
      0,
      ROUND(EXTRACT(EPOCH FROM (NEW.end_ts - NEW.start_ts)) / 60.0)::int
    );
  ELSE
    NEW.duration_minutes := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS production_pointages_set_duration_minutes ON public.production_pointages;
CREATE TRIGGER production_pointages_set_duration_minutes
  BEFORE INSERT OR UPDATE OF start_ts, end_ts
  ON public.production_pointages
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_set_production_pointage_duration_minutes();

-- updated_at (best-effort: the helper is expected to exist already in this DB)
DROP TRIGGER IF EXISTS production_pointages_set_updated_at ON public.production_pointages;
CREATE TRIGGER production_pointages_set_updated_at
  BEFORE UPDATE ON public.production_pointages
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_set_updated_at();

-- Performance indexes
CREATE INDEX IF NOT EXISTS production_pointages_of_id_idx ON public.production_pointages (of_id);
CREATE INDEX IF NOT EXISTS production_pointages_operator_user_id_idx ON public.production_pointages (operator_user_id);
CREATE INDEX IF NOT EXISTS production_pointages_machine_id_idx ON public.production_pointages (machine_id);
CREATE INDEX IF NOT EXISTS production_pointages_poste_id_idx ON public.production_pointages (poste_id);
CREATE INDEX IF NOT EXISTS production_pointages_operation_id_idx ON public.production_pointages (operation_id);
CREATE INDEX IF NOT EXISTS production_pointages_start_ts_idx ON public.production_pointages (start_ts);
CREATE INDEX IF NOT EXISTS production_pointages_status_idx ON public.production_pointages (status);
CREATE INDEX IF NOT EXISTS production_pointages_time_type_idx ON public.production_pointages (time_type);

-- Data integrity: prevent overlapping RUNNING pointages for same operator
CREATE UNIQUE INDEX IF NOT EXISTS production_pointages_running_operator_uniq
  ON public.production_pointages (operator_user_id)
  WHERE status = 'RUNNING';

-- Optional: prevent overlapping RUNNING pointages for same machine (when machine_id is set)
CREATE UNIQUE INDEX IF NOT EXISTS production_pointages_running_machine_uniq
  ON public.production_pointages (machine_id)
  WHERE status = 'RUNNING' AND machine_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.production_pointage_events (
  id bigserial PRIMARY KEY,
  pointage_id uuid NOT NULL
    REFERENCES public.production_pointages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type text NOT NULL,
  old_values jsonb NULL,
  new_values jsonb NULL,
  user_id integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text NULL
);

CREATE INDEX IF NOT EXISTS production_pointage_events_pointage_id_idx
  ON public.production_pointage_events (pointage_id);

CREATE INDEX IF NOT EXISTS production_pointage_events_created_at_idx
  ON public.production_pointage_events (created_at);

CREATE INDEX IF NOT EXISTS production_pointage_events_event_type_idx
  ON public.production_pointage_events (event_type);

COMMENT ON TABLE public.production_pointages IS 'Production time tracking entries (operator/machine/programming) with ISO traceability.';
COMMENT ON TABLE public.production_pointage_events IS 'Append-only event log for production_pointages changes (old/new jsonb + author + timestamp).';
