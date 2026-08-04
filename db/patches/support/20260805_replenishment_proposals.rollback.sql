DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 rollback is restricted to cerp_test';
  END IF;
  IF EXISTS (SELECT 1 FROM public.replenishment_proposal_events)
     OR EXISTS (SELECT 1 FROM public.replenishment_proposals)
     OR EXISTS (SELECT 1 FROM public.replenishment_budgets)
     OR EXISTS (SELECT 1 FROM public.commande_fournisseur WHERE replenishment_proposal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback refused: replenishment evidence exists';
  END IF;
END $$;

BEGIN;
DO $$
BEGIN
  IF to_regclass('public.app_modules') IS NOT NULL THEN
    UPDATE public.app_modules
       SET api_prefixes = array_remove(api_prefixes, '/replenishment-proposals'),
           updated_at = now()
     WHERE module_key = 'commandes-fournisseurs';
  END IF;
END $$;
ALTER TABLE public.commande_fournisseur DROP CONSTRAINT IF EXISTS commande_fournisseur_replenishment_fkey;
DROP INDEX IF EXISTS public.commande_fournisseur_replenishment_idx;
ALTER TABLE public.commande_fournisseur DROP COLUMN IF EXISTS replenishment_proposal_id;
DROP TABLE IF EXISTS public.replenishment_proposal_idempotence;
DROP TABLE IF EXISTS public.replenishment_proposal_events;
DROP INDEX IF EXISTS public.replenishment_proposals_article_site_uniq;
DROP INDEX IF EXISTS public.replenishment_proposals_article_unmapped_uniq;
DROP TABLE IF EXISTS public.replenishment_proposals;
DROP TABLE IF EXISTS public.replenishment_budgets;
DROP FUNCTION IF EXISTS public.fn_replenishment_event_immutable();
ALTER TABLE public.fournisseur_catalogue DROP CONSTRAINT IF EXISTS fournisseur_catalogue_conversion_chk;
ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS lot_achat;
ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS coef_conversion;
ALTER TABLE public.fournisseur_catalogue DROP COLUMN IF EXISTS unite_stock;
ALTER TABLE public.stock_levels DROP CONSTRAINT IF EXISTS stock_levels_replenishment_qty_chk;
ALTER TABLE public.stock_levels DROP COLUMN IF EXISTS order_lot_size;
ALTER TABLE public.stock_levels DROP COLUMN IF EXISTS target_stock_qty;
ALTER TABLE public.stock_levels DROP COLUMN IF EXISTS safety_stock_qty;
COMMIT;
