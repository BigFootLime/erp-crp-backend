-- 20260320_clients_promote_prospect_on_order.sql
--
-- Purpose
-- - Automatically promote a client from 'prospect' to 'client' once an order is placed.
--
-- Notes
-- - Idempotent patch (safe to re-run)
-- - Keeps 'inactif' untouched

BEGIN;

-- Backfill existing prospects with at least one order.
DO $$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL AND to_regclass('public.commande_client') IS NOT NULL THEN
    UPDATE public.clients c
       SET status = 'client'
     WHERE c.status = 'prospect'
       AND EXISTS (
         SELECT 1
           FROM public.commande_client cc
          WHERE cc.client_id = c.client_id
       );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NULL OR to_regclass('public.clients') IS NULL THEN
    RAISE NOTICE 'Skipping trigger creation (missing clients/commande_client tables)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.tg_promote_client_status_on_commande_insert()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF NEW.client_id IS NOT NULL THEN
      UPDATE public.clients
         SET status = 'client'
       WHERE client_id = NEW.client_id
         AND status = 'prospect';
    END IF;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS commande_client_promote_client_status ON public.commande_client;
  CREATE TRIGGER commande_client_promote_client_status
    AFTER INSERT ON public.commande_client
    FOR EACH ROW
    EXECUTE FUNCTION public.tg_promote_client_status_on_commande_insert();
END $$;

COMMIT;
