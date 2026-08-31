-- Article revision-aware stock and guided inventory scopes.
-- Additive and idempotent: canonical lot numbers and historical evidence stay immutable.
BEGIN;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS piece_technique_version_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_piece_technique_version_fkey'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_piece_technique_version_fkey
      FOREIGN KEY (piece_technique_version_id)
      REFERENCES public.piece_technique_versions(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lots_piece_technique_version_idx
  ON public.lots (piece_technique_version_id, article_id, created_at DESC)
  WHERE piece_technique_version_id IS NOT NULL;

-- A lot may have several receipt rows for the same OF/version. Backfill only
-- when every linked OF agrees on one technical version; ambiguous history is
-- deliberately left NULL instead of being guessed.
WITH unambiguous_lot_versions AS (
  SELECT
    output.lot_id,
    (array_agg(DISTINCT fabrication.piece_technique_version_id)
      FILTER (WHERE fabrication.piece_technique_version_id IS NOT NULL))[1] AS version_id
  FROM public.of_output_lots output
  JOIN public.ordres_fabrication fabrication ON fabrication.id = output.of_id
  GROUP BY output.lot_id
  HAVING COUNT(DISTINCT fabrication.piece_technique_version_id)
    FILTER (WHERE fabrication.piece_technique_version_id IS NOT NULL) = 1
)
UPDATE public.lots lot
SET piece_technique_version_id = version.version_id
FROM unambiguous_lot_versions version
WHERE lot.id = version.lot_id
  AND lot.piece_technique_version_id IS NULL;

ALTER TABLE public.stock_inventory_sessions
  ADD COLUMN IF NOT EXISTS scope_article_prefix text NULL;

ALTER TABLE public.stock_inventory_sessions
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_article_prefix_ck;

ALTER TABLE public.stock_inventory_sessions
  ADD CONSTRAINT stock_inventory_sessions_article_prefix_ck
  CHECK (scope_article_prefix IS NULL OR btrim(scope_article_prefix) <> '');

-- Extend the existing scope freeze with the new article-prefix dimension.
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
    OR NEW.scope_article_prefix IS DISTINCT FROM OLD.scope_article_prefix
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

-- Trace references can be corrected during an inventory. The before/after
-- image is appended to stock_lot_event_log before the live references change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT DELETE ON public.stock_lot_trace_references TO cerp_app;
  END IF;
END $$;

COMMIT;
