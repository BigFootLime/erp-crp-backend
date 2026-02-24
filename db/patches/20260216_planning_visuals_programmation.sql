-- DB patch: Planning visuals + Programmation planning
-- Idempotent: safe to run multiple times.

-- 1) Clients: optional deterministic color provided by backend
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS color_hex text NULL;

-- Accept common hex formats (#RRGGBB) when provided.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'clients_color_hex_format'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_color_hex_format
      CHECK (color_hex IS NULL OR color_hex ~* '^#[0-9a-f]{6}$');
  END IF;
END $$;

-- 2) Planning events: visual helpers (deadline, stop reason, blockers)
ALTER TABLE public.planning_events
  ADD COLUMN IF NOT EXISTS deadline_ts timestamptz NULL,
  ADD COLUMN IF NOT EXISTS stop_reason text NULL,
  ADD COLUMN IF NOT EXISTS blockers jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Ensure blockers is always a JSON array (if set manually).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'planning_events_blockers_is_array'
  ) THEN
    ALTER TABLE public.planning_events
      ADD CONSTRAINT planning_events_blockers_is_array
      CHECK (jsonb_typeof(blockers) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS planning_events_deadline_idx
  ON public.planning_events (deadline_ts)
  WHERE deadline_ts IS NOT NULL AND archived_at IS NULL;

-- 3) Programmations: simplified planning for programming tasks

-- Optional extensions (best-effort). Some environments may not allow CREATE EXTENSION.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION pgcrypto (insufficient privileges)';
  END;

  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION uuid-ossp (insufficient privileges)';
  END;
END $$;

CREATE TABLE IF NOT EXISTS public.programmations (
  id uuid PRIMARY KEY,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE CASCADE,

  date_commencement date NOT NULL,
  date_fin date NOT NULL,
  programmer_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  plan_reference text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  archived_at timestamptz NULL,
  archived_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT programmations_dates_ok CHECK (date_commencement <= date_fin)
);

-- Best-effort UUID defaults (db may or may not provide generators)
DO $$
BEGIN
  IF to_regproc('gen_random_uuid()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.programmations ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF to_regproc('uuid_generate_v4()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.programmations ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS programmations_piece_idx
  ON public.programmations (piece_technique_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS programmations_programmer_idx
  ON public.programmations (programmer_user_id)
  WHERE programmer_user_id IS NOT NULL AND archived_at IS NULL;

-- Range index for overlap queries used by the planning board.
CREATE INDEX IF NOT EXISTS programmations_date_range_gist_idx
  ON public.programmations USING gist (daterange(date_commencement, (date_fin + 1), '[)'))
  WHERE archived_at IS NULL;

-- updated_at trigger (only if the shared function exists)
DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS programmations_set_updated_at ON public.programmations';
    EXECUTE 'CREATE TRIGGER programmations_set_updated_at BEFORE UPDATE ON public.programmations FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;
