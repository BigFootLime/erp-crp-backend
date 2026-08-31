-- Conservative rollback: refuse once revision-aware lots or scoped inventories exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lots WHERE piece_technique_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'rollback refused: revision-aware lot data exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.stock_inventory_sessions WHERE scope_article_prefix IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'rollback refused: prefix-scoped inventory sessions exist';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_protect_stock_inventory_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory sessions cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'closed or cancelled inventory sessions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'DRAFT' AND (
    NEW.scope_magasin_id IS DISTINCT FROM OLD.scope_magasin_id
    OR NEW.scope_emplacement_id IS DISTINCT FROM OLD.scope_emplacement_id
    OR NEW.scope_article_id IS DISTINCT FROM OLD.scope_article_id
    OR NEW.scope_article_category IS DISTINCT FROM OLD.scope_article_category
    OR NEW.blind_count IS DISTINCT FROM OLD.blind_count
    OR NEW.requires_second_count IS DISTINCT FROM OLD.requires_second_count
    OR NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at
  ) THEN
    RAISE EXCEPTION 'inventory scope and snapshot are frozen after start'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.stock_inventory_sessions
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_article_prefix_ck,
  DROP COLUMN IF EXISTS scope_article_prefix;

DROP INDEX IF EXISTS public.lots_piece_technique_version_idx;

ALTER TABLE public.lots
  DROP CONSTRAINT IF EXISTS lots_piece_technique_version_fkey,
  DROP COLUMN IF EXISTS piece_technique_version_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    REVOKE DELETE ON public.stock_lot_trace_references FROM cerp_app;
  END IF;
END $$;

