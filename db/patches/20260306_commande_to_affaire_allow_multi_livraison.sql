-- 20260306_commande_to_affaire_allow_multi_livraison.sql
--
-- Purpose
-- - Allow a single commande to map to multiple LIVRAISON affaires (split delivery).
-- - Keep PRODUCTION mapping unique per commande.
--
-- Safety
-- - Idempotent: safe to run multiple times.
-- - Drops a previously-created unique index that enforced (commande_id, role) uniqueness.

BEGIN;

-- Previous patch created a unique index that blocks multiple LIVRAISON rows.
DROP INDEX IF EXISTS public.commande_to_affaire_commande_role_uniq;

DO $$
BEGIN
  IF to_regclass('public.commande_to_affaire') IS NULL THEN
    RAISE NOTICE 'Skipping multi-livraison index: public.commande_to_affaire missing';
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
    RAISE NOTICE 'Skipping multi-livraison index: public.commande_to_affaire.role missing';
    RETURN;
  END IF;

  -- Enforce uniqueness only for PRODUCTION mappings.
  EXECUTE $sql$
    CREATE UNIQUE INDEX IF NOT EXISTS commande_to_affaire_commande_role_production_uniq
      ON public.commande_to_affaire (commande_id, role)
      WHERE role = 'PRODUCTION'
  $sql$;
END $$;

COMMIT;
