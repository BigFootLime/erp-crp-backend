-- Planning (Scheduler) module tables.
-- Idempotent patch: safe to run multiple times.

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

  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS btree_gist';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION btree_gist (insufficient privileges)';
  END;
END $$;

-- Types
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'planning_event_kind') THEN
    CREATE TYPE planning_event_kind AS ENUM ('OF_OPERATION', 'MAINTENANCE', 'CUSTOM');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'planning_event_status') THEN
    CREATE TYPE planning_event_status AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'BLOCKED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'planning_priority') THEN
    CREATE TYPE planning_priority AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');
  END IF;
END $$;

-- Core planning events
CREATE TABLE IF NOT EXISTS public.planning_events (
  id uuid PRIMARY KEY,
  kind planning_event_kind NOT NULL DEFAULT 'OF_OPERATION',
  status planning_event_status NOT NULL DEFAULT 'PLANNED',
  priority planning_priority NOT NULL DEFAULT 'NORMAL',

  of_id bigint NULL REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL,
  of_operation_id uuid NULL REFERENCES public.of_operations(id) ON DELETE SET NULL,

  machine_id uuid NULL REFERENCES public.machines(id) ON DELETE SET NULL,
  poste_id uuid NULL REFERENCES public.postes(id) ON DELETE SET NULL,

  title text NOT NULL,
  description text NULL,

  start_ts timestamptz NOT NULL,
  end_ts timestamptz NOT NULL,
  allow_overlap boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  archived_at timestamptz NULL,
  archived_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT planning_events_time_ok CHECK (start_ts < end_ts),
  CONSTRAINT planning_events_one_resource CHECK ((machine_id IS NULL) <> (poste_id IS NULL))
);

-- Best-effort UUID defaults (db may or may not provide generators)
DO $$
BEGIN
  IF to_regproc('gen_random_uuid()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.planning_events ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF to_regproc('uuid_generate_v4()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.planning_events ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS planning_events_of_id_idx
  ON public.planning_events (of_id)
  WHERE of_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS planning_events_of_operation_id_idx
  ON public.planning_events (of_operation_id)
  WHERE of_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS planning_events_machine_time_idx
  ON public.planning_events (machine_id, start_ts, end_ts)
  WHERE machine_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS planning_events_poste_time_idx
  ON public.planning_events (poste_id, start_ts, end_ts)
  WHERE poste_id IS NOT NULL AND archived_at IS NULL;

-- Range indexes (do not require btree_gist)
CREATE INDEX IF NOT EXISTS planning_events_machine_range_gist_idx
  ON public.planning_events USING gist (tstzrange(start_ts, end_ts, '[)'))
  WHERE machine_id IS NOT NULL AND archived_at IS NULL AND allow_overlap IS NOT TRUE;

CREATE INDEX IF NOT EXISTS planning_events_poste_range_gist_idx
  ON public.planning_events USING gist (tstzrange(start_ts, end_ts, '[)'))
  WHERE poste_id IS NOT NULL AND archived_at IS NULL AND allow_overlap IS NOT TRUE;

-- Optional overlap exclusion constraints (stronger than app-level checks)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planning_events_machine_no_overlap') THEN
      EXECUTE $SQL$
        ALTER TABLE public.planning_events
        ADD CONSTRAINT planning_events_machine_no_overlap
        EXCLUDE USING gist (
          machine_id WITH =,
          tstzrange(start_ts, end_ts, '[)') WITH &&
        )
        WHERE (machine_id IS NOT NULL AND archived_at IS NULL AND allow_overlap IS NOT TRUE)
      $SQL$;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planning_events_poste_no_overlap') THEN
      EXECUTE $SQL$
        ALTER TABLE public.planning_events
        ADD CONSTRAINT planning_events_poste_no_overlap
        EXCLUDE USING gist (
          poste_id WITH =,
          tstzrange(start_ts, end_ts, '[)') WITH &&
        )
        WHERE (poste_id IS NOT NULL AND archived_at IS NULL AND allow_overlap IS NOT TRUE)
      $SQL$;
    END IF;
  END IF;
END $$;

-- updated_at trigger (only if the shared function exists)
DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS planning_events_set_updated_at ON public.planning_events';
    EXECUTE 'CREATE TRIGGER planning_events_set_updated_at BEFORE UPDATE ON public.planning_events FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

-- Comments
CREATE TABLE IF NOT EXISTS public.planning_event_comments (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.planning_events(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regproc('gen_random_uuid()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.planning_event_comments ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF to_regproc('uuid_generate_v4()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.planning_event_comments ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS planning_event_comments_event_idx
  ON public.planning_event_comments (event_id, created_at);

-- Documents (attachments) via existing documents_clients table
CREATE TABLE IF NOT EXISTS public.planning_event_documents (
  event_id uuid NOT NULL REFERENCES public.planning_events(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents_clients(id) ON DELETE CASCADE,
  type text NULL,
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, document_id)
);

CREATE INDEX IF NOT EXISTS planning_event_documents_event_idx
  ON public.planning_event_documents (event_id);
