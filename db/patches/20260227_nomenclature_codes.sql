-- 20260227_nomenclature_codes.sql
-- Phase: Global nomenclature codes (generic sequences + client codes + CAP reference)
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Generic sequences table + atomic allocator                              */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.code_sequences (
  code_key text PRIMARY KEY,
  next_value bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fn_next_code_value(p_key text)
RETURNS bigint
LANGUAGE sql
AS $$
  WITH upsert AS (
    INSERT INTO public.code_sequences (code_key, next_value)
    VALUES (p_key, 2)
    ON CONFLICT (code_key)
    DO UPDATE SET
      next_value = public.code_sequences.next_value + 1,
      updated_at = now()
    RETURNING next_value
  )
  SELECT (next_value - 1)::bigint FROM upsert;
$$;

/* -------------------------------------------------------------------------- */
/* 1b) Client code (CLI-001)                                                  */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  v_max bigint;
BEGIN
  IF to_regclass('public.clients') IS NULL THEN
    RAISE NOTICE 'Skipping client_code (public.clients missing)';
    RETURN;
  END IF;

  ALTER TABLE public.clients
    ADD COLUMN IF NOT EXISTS client_code text NULL;

  -- Backfill from existing client_id when possible.
  UPDATE public.clients
  SET client_code = 'CLI-' || lpad((client_id)::text, 3, '0')
  WHERE (client_code IS NULL OR btrim(client_code) = '')
    AND client_id ~ '^\\d+$';

  -- Initialize/update the CLI sequence key.
  SELECT COALESCE(MAX((regexp_match(client_code, '^CLI-(\\d{3})$'))[1]::bigint), 0)
  INTO v_max
  FROM public.clients
  WHERE client_code IS NOT NULL;

  INSERT INTO public.code_sequences (code_key, next_value)
  VALUES ('CLI', v_max + 1)
  ON CONFLICT (code_key)
  DO UPDATE SET
    next_value = GREATEST(public.code_sequences.next_value, EXCLUDED.next_value),
    updated_at = now();

  -- Enforce uniqueness.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'clients_client_code_key'
      AND c.conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_client_code_key UNIQUE (client_code);
  END IF;

  -- Enforce NOT NULL only if all rows have a code.
  IF NOT EXISTS (
    SELECT 1
    FROM public.clients
    WHERE client_code IS NULL OR btrim(client_code) = ''
  ) THEN
    ALTER TABLE public.clients
      ALTER COLUMN client_code SET NOT NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1c) Optional init: fournisseur/article sequences (if data already exists)   */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  v_max bigint;
BEGIN
  IF to_regclass('public.fournisseurs') IS NOT NULL THEN
    SELECT COALESCE(MAX((regexp_match(code, '^FOU-(\\d{3})$'))[1]::bigint), 0)
    INTO v_max
    FROM public.fournisseurs
    WHERE code IS NOT NULL;

    IF v_max > 0 THEN
      INSERT INTO public.code_sequences (code_key, next_value)
      VALUES ('FOU', v_max + 1)
      ON CONFLICT (code_key)
      DO UPDATE SET
        next_value = GREATEST(public.code_sequences.next_value, EXCLUDED.next_value),
        updated_at = now();
    END IF;
  END IF;

  IF to_regclass('public.articles') IS NOT NULL THEN
    SELECT COALESCE(MAX((regexp_match(code, '^ART-(\\d{4})$'))[1]::bigint), 0)
    INTO v_max
    FROM public.articles
    WHERE code IS NOT NULL;

    IF v_max > 0 THEN
      INSERT INTO public.code_sequences (code_key, next_value)
      VALUES ('ART', v_max + 1)
      ON CONFLICT (code_key)
      DO UPDATE SET
        next_value = GREATEST(public.code_sequences.next_value, EXCLUDED.next_value),
        updated_at = now();
    END IF;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) CAPA action reference (CAP-YYYY-00001)                                  */
/* -------------------------------------------------------------------------- */

-- Create a dedicated sequence + generator function (mirrors NC generator).
CREATE SEQUENCE IF NOT EXISTS public.quality_action_reference_seq;

CREATE OR REPLACE FUNCTION public.quality_generate_action_reference()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v bigint;
  y text;
BEGIN
  v := nextval('public.quality_action_reference_seq');
  y := to_char(now(), 'YYYY');
  RETURN 'CAP-' || y || '-' || lpad(v::text, 5, '0');
END;
$$;

DO $$
DECLARE
  v_max bigint;
BEGIN
  IF to_regclass('public.quality_action') IS NULL THEN
    RAISE NOTICE 'Skipping quality_action reference (public.quality_action missing)';
    RETURN;
  END IF;

  -- Add the reference column only if missing.
  ALTER TABLE public.quality_action
    ADD COLUMN IF NOT EXISTS reference text NULL;

  -- Ensure a default exists for future inserts.
  ALTER TABLE public.quality_action
    ALTER COLUMN reference SET DEFAULT public.quality_generate_action_reference();

  -- Ensure sequence is ahead of any existing references.
  SELECT COALESCE(MAX((regexp_match(reference, '^CAP-\\d{4}-(\\d{5})$'))[1]::bigint), 0)
  INTO v_max
  FROM public.quality_action
  WHERE reference IS NOT NULL;

  IF v_max > 0 THEN
    PERFORM setval('public.quality_action_reference_seq', v_max);
  END IF;

  -- Backfill existing rows.
  UPDATE public.quality_action
  SET reference = public.quality_generate_action_reference()
  WHERE reference IS NULL OR btrim(reference) = '';

  -- Enforce NOT NULL + UNIQUE, idempotently.
  ALTER TABLE public.quality_action
    ALTER COLUMN reference SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'quality_action_reference_key'
      AND c.conrelid = 'public.quality_action'::regclass
  ) THEN
    ALTER TABLE public.quality_action
      ADD CONSTRAINT quality_action_reference_key UNIQUE (reference);
  END IF;
END $$;

COMMIT;
