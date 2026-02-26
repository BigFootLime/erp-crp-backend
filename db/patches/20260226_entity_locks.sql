-- Entity locks (Phase 13C - realtime multi-user edit locks)
-- Idempotent patch: safe to run multiple times.

BEGIN;

CREATE TABLE IF NOT EXISTS public.entity_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  locked_by INTEGER NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_locks_entity_uniq ON public.entity_locks(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS entity_locks_expires_at_idx ON public.entity_locks(expires_at);
CREATE INDEX IF NOT EXISTS entity_locks_locked_by_idx ON public.entity_locks(locked_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_locks_locked_by_fkey'
      AND conrelid = 'public.entity_locks'::regclass
  ) THEN
    ALTER TABLE public.entity_locks
      ADD CONSTRAINT entity_locks_locked_by_fkey
      FOREIGN KEY (locked_by) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_locks_entity_type_check'
      AND conrelid = 'public.entity_locks'::regclass
  ) THEN
    ALTER TABLE public.entity_locks
      ADD CONSTRAINT entity_locks_entity_type_check
      CHECK (length(trim(entity_type)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_locks_entity_id_check'
      AND conrelid = 'public.entity_locks'::regclass
  ) THEN
    ALTER TABLE public.entity_locks
      ADD CONSTRAINT entity_locks_entity_id_check
      CHECK (length(trim(entity_id)) > 0);
  END IF;
END $$;

COMMIT;
