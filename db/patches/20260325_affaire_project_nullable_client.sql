-- 20260325_affaire_project_nullable_client.sql
-- Allow project records (affaire.type_affaire='projet') to exist without a client.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.affaire') IS NOT NULL THEN
    ALTER TABLE public.affaire
      ALTER COLUMN client_id DROP NOT NULL;
  END IF;
END $$;

COMMIT;
