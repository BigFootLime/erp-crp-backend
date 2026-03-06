-- 20260306_livraison_only_affaires.sql
--
-- Purpose
-- - Enforce a single affaire type: 'livraison'.
-- - Remove the PRODUCTION role from commande_to_affaire (backfill to LIVRAISON).
--
-- Safety
-- - Idempotent: safe to run multiple times.
-- - Best-effort: skips sections when tables/columns are missing.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) public.affaire.type_affaire -> 'livraison'                               */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.affaire') IS NULL THEN
    RAISE NOTICE 'Skipping: public.affaire missing';
    RETURN;
  END IF;

  -- Drop any existing CHECK constraints that mention type_affaire.
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.affaire'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%type_affaire%'
  LOOP
    EXECUTE format('ALTER TABLE public.affaire DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- Normalize existing data.
  EXECUTE $sql$
    UPDATE public.affaire
    SET type_affaire = 'livraison'
    WHERE type_affaire IS DISTINCT FROM 'livraison'
  $sql$;

  -- Ensure inserts default to livraison.
  EXECUTE 'ALTER TABLE public.affaire ALTER COLUMN type_affaire SET DEFAULT ''livraison''';

  -- Enforce livraison-only going forward.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affaire_type_affaire_livraison_check'
      AND conrelid = 'public.affaire'::regclass
  ) THEN
    EXECUTE $sql$
      ALTER TABLE public.affaire
      ADD CONSTRAINT affaire_type_affaire_livraison_check
      CHECK (type_affaire = 'livraison')
    $sql$;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) public.commande_client.type_affaire -> 'livraison'                       */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.commande_client') IS NULL THEN
    RAISE NOTICE 'Skipping: public.commande_client missing';
    RETURN;
  END IF;

  -- Drop any existing CHECK constraints that mention type_affaire.
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.commande_client'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%type_affaire%'
  LOOP
    EXECUTE format('ALTER TABLE public.commande_client DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- Normalize existing data.
  EXECUTE $sql$
    UPDATE public.commande_client
    SET type_affaire = 'livraison'
    WHERE type_affaire IS DISTINCT FROM 'livraison'
  $sql$;

  -- Ensure inserts default to livraison.
  EXECUTE 'ALTER TABLE public.commande_client ALTER COLUMN type_affaire SET DEFAULT ''livraison''';

  -- Enforce livraison-only going forward.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_client_type_affaire_livraison_check'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    EXECUTE $sql$
      ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_type_affaire_livraison_check
      CHECK (type_affaire = 'livraison')
    $sql$;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) public.commande_to_affaire.role -> LIVRAISON only                        */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.commande_to_affaire') IS NULL THEN
    RAISE NOTICE 'Skipping: public.commande_to_affaire missing';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.commande_to_affaire'::regclass
      AND attname = 'role'
      AND NOT attisdropped
    LIMIT 1
  ) THEN
    RAISE NOTICE 'Skipping: public.commande_to_affaire.role missing';
    RETURN;
  END IF;

  -- Remove the PRODUCTION-only uniqueness constraint (if present).
  EXECUTE 'DROP INDEX IF EXISTS public.commande_to_affaire_commande_role_production_uniq';

  -- Backfill existing PRODUCTION rows to LIVRAISON.
  EXECUTE $sql$
    UPDATE public.commande_to_affaire
    SET role = 'LIVRAISON'
    WHERE role = 'PRODUCTION'
  $sql$;

  -- Tighten the role check constraint to only allow LIVRAISON (or NULL).
  EXECUTE 'ALTER TABLE public.commande_to_affaire DROP CONSTRAINT IF EXISTS commande_to_affaire_role_check';
  EXECUTE $sql$
    ALTER TABLE public.commande_to_affaire
    ADD CONSTRAINT commande_to_affaire_role_check
    CHECK (role IS NULL OR role IN ('LIVRAISON'))
  $sql$;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) public.commande_ligne_affaire_allocation.production_affaire_id -> NULL   */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.commande_ligne_affaire_allocation') IS NULL THEN
    RAISE NOTICE 'Skipping: public.commande_ligne_affaire_allocation missing';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.commande_ligne_affaire_allocation'::regclass
      AND attname = 'production_affaire_id'
      AND NOT attisdropped
    LIMIT 1
  ) THEN
    RAISE NOTICE 'Skipping: public.commande_ligne_affaire_allocation.production_affaire_id missing';
    RETURN;
  END IF;

  EXECUTE $sql$
    UPDATE public.commande_ligne_affaire_allocation
    SET production_affaire_id = NULL
    WHERE production_affaire_id IS NOT NULL
  $sql$;
END $$;

COMMIT;
