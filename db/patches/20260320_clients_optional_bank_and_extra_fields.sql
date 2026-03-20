-- 20260320_clients_optional_bank_and_extra_fields.sql
--
-- Purpose
-- - Allow saving clients without bank info (clients.bank_info_id becomes nullable)
-- - Add optional address complement fields (billing + delivery)
-- - Add optional contact direct phone field
--
-- Notes
-- - Idempotent patch (safe to re-run)
-- - No data loss: only ALTER TABLE / ADD COLUMN

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.adresse_facturation') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adresse_facturation ADD COLUMN IF NOT EXISTS address_complement TEXT NULL';
  END IF;

  IF to_regclass('public.adresse_livraison') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adresse_livraison ADD COLUMN IF NOT EXISTS address_complement TEXT NULL';
  END IF;

  IF to_regclass('public.contacts') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS phone_direct TEXT NULL';
  END IF;

  IF to_regclass('public.clients') IS NOT NULL THEN
    BEGIN
      EXECUTE 'ALTER TABLE public.clients ALTER COLUMN bank_info_id DROP NOT NULL';
    EXCEPTION
      WHEN undefined_column THEN
        RAISE NOTICE 'Skipping clients.bank_info_id DROP NOT NULL (column missing)';
    END;
  END IF;
END $$;

COMMIT;
