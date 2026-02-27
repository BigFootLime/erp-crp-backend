-- Phase 14: Quick commande preview/confirm + idempotency.
-- Date: 2026-02-26
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Optional extensions (best-effort)                                        */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION pgcrypto (insufficient privileges)';
  END;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Preview storage (short-lived)                                            */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quick_commande_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  input_json jsonb NOT NULL,
  plan_json jsonb NOT NULL,

  confirmed_at timestamptz NULL,
  confirmed_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  confirmed_commande_id bigint NULL REFERENCES public.commande_client(id) ON DELETE SET NULL,
  confirmed_response jsonb NULL
);

CREATE INDEX IF NOT EXISTS quick_commande_previews_expires_at_idx
  ON public.quick_commande_previews (expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quick_commande_previews_expires_after_created'
      AND conrelid = 'public.quick_commande_previews'::regclass
  ) THEN
    ALTER TABLE public.quick_commande_previews
      ADD CONSTRAINT quick_commande_previews_expires_after_created
      CHECK (expires_at > created_at);
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Confirm idempotency store                                                */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quick_commande_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'STARTED',
  preview_id uuid NULL REFERENCES public.quick_commande_previews(id) ON DELETE SET NULL,
  request_hash text NULL,

  response_json jsonb NULL,
  commande_id bigint NULL REFERENCES public.commande_client(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS quick_commande_confirmations_idempotency_key_uniq
  ON public.quick_commande_confirmations (idempotency_key);

CREATE INDEX IF NOT EXISTS quick_commande_confirmations_status_idx
  ON public.quick_commande_confirmations (status);

CREATE INDEX IF NOT EXISTS quick_commande_confirmations_preview_id_idx
  ON public.quick_commande_confirmations (preview_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quick_commande_confirmations_status_allowed'
      AND conrelid = 'public.quick_commande_confirmations'::regclass
  ) THEN
    ALTER TABLE public.quick_commande_confirmations
      ADD CONSTRAINT quick_commande_confirmations_status_allowed
      CHECK (status IN ('STARTED', 'CONFIRMED', 'FAILED'));
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) updated_at trigger (only if the shared function exists)                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS quick_commande_confirmations_set_updated_at ON public.quick_commande_confirmations';
    EXECUTE 'CREATE TRIGGER quick_commande_confirmations_set_updated_at BEFORE UPDATE ON public.quick_commande_confirmations FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

COMMIT;
