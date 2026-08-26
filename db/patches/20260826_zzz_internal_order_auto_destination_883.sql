-- Commandes internes: NEW-PF and the client location are resolved when the
-- finished part is received. The order itself must therefore remain valid
-- without a preselected stock destination.

BEGIN;

ALTER TABLE public.commande_client
  DROP CONSTRAINT IF EXISTS commande_client_internal_stock_dest_check;

COMMIT;
